import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { config } from './config.js';
import { corsHeaders } from './cors.js';
import { logger } from './logger.js';
import { StickySessions } from './stickySessions.js';

const clientFor = (protocol) => (protocol === 'https:' ? https : http);

// Errors that mean "this backend is not answering", as opposed to "this request
// took a long time", which is normal for a long-poll.
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

// The exact payload Engine.IO sends for an unrecognised sid. Returning it from
// the balancer makes the client re-handshake immediately instead of retrying a
// session no backend can serve.
const UNKNOWN_SESSION = JSON.stringify({ code: 1, message: 'Session ID unknown' });

// A gateway status means the request never reached the backend's application:
// the platform's own edge answered for it. Distinct from 500, which the app
// itself produced and which says nothing about whether it is serving.
const GATEWAY_ERRORS = new Set([502, 503, 504]);

// An Engine.IO open packet is ~120 bytes. Anything past this is not a handshake,
// and buffering it would grow without bound on a long-poll.
const HANDSHAKE_SCAN_LIMIT = 2048;

const isSocketRequest = (url) => url.startsWith(config.socketPathPrefix);

const buildUpstreamOptions = (req, targetUrl, timeoutMs, { readableBody = false } = {}) => {
  const upstream = new URL(req.url, targetUrl);
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = req.socket.remoteAddress || '';

  const headers = {
    ...req.headers,
    host: upstream.host,
    // The balancer reads the handshake body to learn the sid, so that one
    // response must not be compressed. Client headers are forwarded verbatim,
    // and both browsers ("gzip, deflate, br") and Render's Cloudflare edge
    // ("gzip", added even when the client asked for nothing) request encoding
    // the regex cannot match -- the sid is never learned and every follow-up
    // request 400s. Overriding costs nothing: the handshake is ~120 bytes,
    // below any compression threshold, and serving identity to a client that
    // offered gzip is always legal.
    ...(readableBody ? { 'accept-encoding': 'identity' } : {}),
    // Append, never overwrite: preserves the chain when another proxy (Render's
    // edge) already added a hop.
    'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${clientIp}` : clientIp,
    // Must describe how the CLIENT reached us, not how we reach the backend.
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'),
    'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host || upstream.host,
  };

  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: `${upstream.pathname}${upstream.search}`,
    method: req.method,
    headers,
    timeout: timeoutMs,
    agent: false,
  };
};

/**
 * Decides which backend serves a request.
 *
 * Stateless traffic round-robins. Socket traffic that names a session (`?sid=`)
 * is pinned to the backend that owns it.
 */
const resolveTarget = (req, { pool, sticky }) => {
  const sid = isSocketRequest(req.url) ? StickySessions.sidFrom(req.url) : null;

  if (!sid) {
    const url = pool.next();
    return url ? { url, sid: null } : { error: 'no_healthy_backends' };
  }

  const pinned = sticky.get(sid);
  if (!pinned) return { error: 'unknown_session', sid };
  if (!pool.isHealthy(pinned)) {
    sticky.delete(sid);
    return { error: 'unknown_session', sid };
  }
  return { url: pinned, sid };
};

/** Errors the balancer originates must carry CORS, or the client cannot read them. */
const respond = (req, res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders(req) });
  res.end(body);
};

// A preflight names no session -- it asks whether the real request is permitted.
// Routing it through sticky affinity would reject it as an unknown sid and take
// the real request down with it.
const answerPreflight = (req, res) => {
  const headers = corsHeaders(req);
  if (!headers['access-control-allow-origin']) {
    res.writeHead(403).end();
    return;
  }
  res.writeHead(204, {
    ...headers,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type,authorization',
    'access-control-max-age': '86400',
  });
  res.end();
};

export const forwardRequest = (req, res, ctx) => {
  const { pool, sticky } = ctx;
  const socketTraffic = isSocketRequest(req.url);

  if (socketTraffic && req.method === 'OPTIONS') {
    answerPreflight(req, res);
    return;
  }

  const route = resolveTarget(req, ctx);

  if (route.error === 'unknown_session') {
    logger.warn('unknown session, forcing re-handshake', { sid: route.sid });
    respond(req, res, 400, UNKNOWN_SESSION);
    return;
  }
  if (route.error) {
    respond(req, res, 503, JSON.stringify({ error: 'no_healthy_backends' }));
    return;
  }

  // A socket request that names no session is the handshake: the response body
  // carries the sid this backend just created, and is the only body the balancer
  // needs to read.
  const isHandshake = socketTraffic && !route.sid;

  const timeoutMs = socketTraffic ? config.socketTimeoutMs : config.requestTimeoutMs;
  const options = buildUpstreamOptions(req, route.url, timeoutMs, { readableBody: isHandshake });
  const proxyReq = clientFor(options.protocol).request(options, (proxyRes) => {
    const status = proxyRes.statusCode || 502;

    // A gateway status is the platform's edge reporting that it has no instance
    // to hand the request to -- a suspended or undeployed backend answers this
    // way instead of refusing the connection, so it looks nothing like the
    // ECONNREFUSED the breaker was written to catch. Treating it as a success
    // would leave a backend that cannot serve anything in rotation forever,
    // failing one request in `pool.size` indefinitely.
    if (GATEWAY_ERRORS.has(status)) pool.markDown(route.url, `HTTP ${status}`);
    // Any other response proves the backend is reachable, which is the only
    // recovery signal available when active probing is disabled.
    else pool.markUp(route.url);

    // That edge response is generated before the backend's CORS middleware ever
    // runs, so it carries no Access-Control-Allow-Origin. Forwarded verbatim it
    // reaches the browser as an opaque CORS failure rather than as a 502, and an
    // Engine.IO client that cannot read the status cannot fall back. Supply the
    // headers the backend would have, without ever overwriting ones it did send.
    const headers = { ...proxyRes.headers };
    if (status >= 500 && !headers['access-control-allow-origin']) {
      Object.assign(headers, corsHeaders(req));
    }

    // Learn the sid from a handshake so its follow-up requests can be pinned.
    if (isHandshake && status === 200) {
      // Buffer across chunks rather than testing each one: the open packet is
      // small enough to arrive whole today, but a sid split over a chunk
      // boundary would silently unpin the session.
      let scanned = '';
      let captured = null;
      proxyRes.on('data', (chunk) => {
        if (captured || scanned.length > HANDSHAKE_SCAN_LIMIT) return;
        scanned += chunk.toString('utf8');
        captured = StickySessions.sidFromHandshake(scanned);
        if (captured) {
          scanned = '';
          sticky.set(captured, route.url);
          logger.info('session pinned', { sid: captured, backend: route.url });
        }
      });
      // Affinity is the whole reason this balancer exists in front of Engine.IO.
      // Losing it degrades silently -- the client just reconnects forever -- so
      // it must be loud in the log rather than inferred from a 400 storm.
      proxyRes.on('end', () => {
        if (captured) return;
        logger.error('handshake carried no readable sid; session cannot be pinned', {
          backend: route.url,
          contentEncoding: proxyRes.headers['content-encoding'] || 'identity',
        });
      });
    }

    res.writeHead(status, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => {
    // Not a health signal. Fail this one request only.
    proxyReq.destroy(new Error('proxy timeout'));
  });

  proxyReq.on('error', (error) => {
    if (CONNECTION_ERRORS.has(error.code)) pool.markDown(route.url, error.code);
    logger.error('upstream error', { backend: route.url, path: options.path, reason: error.message });
    // Once the backend's headers are out, its body is half-written; appending a
    // JSON error would corrupt it. Sever instead, so the client sees a failure.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    respond(req, res, 502, JSON.stringify({ error: 'upstream_unavailable' }));
  });

  req.pipe(proxyReq);
};

const abortSocket = (socket, status, reason, body = '') => {
  const payload = body ? `\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}` : '';
  socket.write(`HTTP/1.1 ${status} ${reason}${payload}\r\n\r\n${body}`);
  socket.destroy();
};

export const forwardUpgrade = (req, socket, head, ctx) => {
  const { pool, sticky } = ctx;
  const route = resolveTarget(req, ctx);

  if (route.error === 'unknown_session') {
    abortSocket(socket, 400, 'Bad Request', UNKNOWN_SESSION);
    return;
  }
  if (route.error) {
    abortSocket(socket, 503, 'Service Unavailable');
    return;
  }

  const options = buildUpstreamOptions(req, route.url, config.socketTimeoutMs);
  options.headers.connection = 'upgrade';
  options.headers.upgrade = req.headers.upgrade || 'websocket';

  const proxyReq = clientFor(options.protocol).request(options);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    pool.markUp(route.url);

    // The tunnel is now client<->backend; neither side should carry an idle
    // timeout, and Nagle would add latency to small realtime frames.
    proxySocket.setTimeout(0);
    proxySocket.setNoDelay(true);
    socket.setTimeout(0);
    socket.setNoDelay(true);

    const headers = Object.entries(proxyRes.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    socket.write(`HTTP/1.1 101 ${proxyRes.statusMessage || 'Switching Protocols'}\r\n${headers}\r\n\r\n`);

    if (proxyHead?.length) proxySocket.unshift(proxyHead);

    const teardown = () => { proxySocket.destroy(); socket.destroy(); };
    proxySocket.on('error', teardown);
    socket.on('error', teardown);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  // A backend that answers an Upgrade with a normal response is refusing it.
  proxyReq.on('response', (proxyRes) => {
    const headers = Object.entries(proxyRes.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\n${headers}\r\n\r\n`);
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', (error) => {
    if (CONNECTION_ERRORS.has(error.code)) pool.markDown(route.url, error.code);
    logger.error('upgrade failed', { backend: route.url, reason: error.message });
    abortSocket(socket, 502, 'Bad Gateway');
  });

  socket.on('error', () => proxyReq.destroy());
  proxyReq.end(head);
};
