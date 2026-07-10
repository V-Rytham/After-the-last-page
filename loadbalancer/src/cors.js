import { config } from './config.js';

/**
 * CORS for responses the balancer *originates*.
 *
 * Proxied responses already carry the backend's CORS headers and must not be
 * touched. But an error the balancer answers itself -- unknown session, no
 * healthy backend, bad gateway -- never reaches a backend, so nothing adds them.
 *
 * A browser blocks such a response before the client can read its status. For
 * Engine.IO that is not a cosmetic failure: the 400 {"code":1} that tells the
 * client to re-handshake is exactly the response most likely to be generated
 * here, and a client that cannot read it retries the dead sid forever.
 */
const isAllowed = (origin) => {
  if (!origin) return false;
  if (config.allowedOrigins.has(origin)) return true;

  try {
    const { hostname, port } = new URL(origin);
    if (hostname.endsWith('.onrender.com')) return true;
    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname);
    return isLocalhost && (port === '' || ['5173', '5174', '3000', '3001', '8080'].includes(port));
  } catch {
    return false;
  }
};

/** Mirrors the backend's policy so an error looks the same to the client as a success. */
export const corsHeaders = (req) => {
  const origin = req.headers.origin;
  if (!isAllowed(origin)) return {};

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    // The header set depends on Origin, so caches must not serve one origin's
    // response to another.
    vary: 'Origin',
  };
};
