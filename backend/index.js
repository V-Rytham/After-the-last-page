// Must precede every module that reads process.env.
import './config/env.js';

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import path from 'path';
import { connectDB } from './config/db.js';
import userRoutes from './routes/userRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import authRoutes from './routes/authRoutes.js';
import registerSocketEvents from './socket/socketHandler.js';
import accessRoutes from './routes/accessRoutes.js';
import { buildSessionRoutes } from './routes/sessionRoutes.js';
import { buildMatchmakingRoutes } from './routes/matchmakingRoutes.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { rateLimit } from './middleware/rateLimit.js';
import { errorHandler, notFound } from './middleware/errorMiddleware.js';
import { isProd } from './utils/runtime.js';
import { log } from './utils/logger.js';
import { RealtimeSessionManager } from './services/realtimeSessionManager.js';
import { createRedisClients } from './services/realtime/redisClients.js';
import { requestTracing } from './middleware/requestLogging.js';
import recommendationsRoutes from './routes/recommendationsRoutes.js';
import searchRoutes from './routes/searchRoutes.js';
import readingRoutes from './routes/readingRoutes.js';
import { bootstrapFeatureModules } from './core/bootstrapModules.js';
import passport from './config/passport.js';
import { configurePassport } from './config/passport.js';
import { requireDatabase } from './middleware/degradedModeMiddleware.js';
import { buildBookThreadsRoutes } from './features/bookThreads/bookThreadsRoutes.js';
import { BookfriendClient } from './src/integrations/bookfriend/client/BookfriendClient.js';
import { getBookfriendConfig } from './src/integrations/bookfriend/config/bookfriendConfig.js';
import { BookfriendHealthMonitor } from './src/integrations/bookfriend/health/BookfriendHealthMonitor.js';
import { BookfriendGatewayService } from './src/integrations/bookfriend/services/BookfriendGatewayService.js';
import { requestIdMiddleware } from './middleware/requestIdMiddleware.js';
import { isOriginAllowed } from './utils/corsOrigins.js';

const app = express();
app.disable('x-powered-by');
// Number of proxies in front of this process, counted from the socket backwards.
// In production that is Render's edge *and* our own load balancer, so a request
// arrives with `x-forwarded-for: <client>, <edge>`. Under-counting makes
// `req.ip` resolve to a proxy's address, which is identical for every visitor --
// collapsing the per-IP rate limiter (middleware/rateLimit.js) into one global
// bucket. Override if the number of hops changes.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (isProd() ? 2 : 0));
app.set('trust proxy', Number.isFinite(trustProxyHops) ? trustProxyHops : 0);

const httpServer = createServer(app);

const jwtSecret = String(process.env.JWT_SECRET || '').trim();
if (!jwtSecret) {
  console.error('[SERVER] JWT_SECRET is required.');
  process.exit(1);
}

if (isProd() && jwtSecret === 'change_me_in_production') {
  console.error('[SERVER] Refusing to start in production with an unsafe JWT_SECRET.');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[SERVER] Uncaught exception:', error);
  process.exit(1);
});

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Socket origin not allowed: ${origin}`));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60_000,
  pingInterval: 25_000,
  connectTimeout: 45_000,
  allowEIO3: true,
});

// Redis is not optional. Engine.IO sessions are pinned to one instance by the
// load balancer, but matchmaking pairs readers across instances and rooms span
// them. Without a shared adapter and store, two readers on different instances
// can never be matched, and broadcasts reach only one process. Failing fast here
// beats silently degrading to a single-instance-only deployment.
const redisUrl = String(process.env.REDIS_URL || '').trim();
if (!redisUrl) {
  console.error('[SERVER] REDIS_URL is required.');
  process.exit(1);
}

let redis;
try {
  redis = await createRedisClients(redisUrl);
} catch (error) {
  console.error('[SERVER] Failed to connect to Redis:', error?.message || error);
  process.exit(1);
}

io.adapter(createAdapter(redis.pub, redis.sub));
log('[SERVER] Socket.IO Redis adapter enabled');

configurePassport();

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },

  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  // Explicitly allow custom identity headers used by the frontend client.
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-User-Id',
    'X-Display-Name',
  ],

  credentials: true,
};

app.use(cors(corsOptions));

// Express v5 / path-to-regexp no longer supports '*' as a route pattern.
app.options(/.*/, cors(corsOptions));
app.use(cookieParser());
app.use(passport.initialize());
app.use(securityHeaders);
app.use(requestTracing);
app.use(requestIdMiddleware);
app.use(express.json({ limit: '7mb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'backend', 'uploads'), {
  fallthrough: true,
  maxAge: isProd() ? '7d' : 0,
}));

// Baseline abuse protection for all endpoints.
app.use(rateLimit({ windowMs: 15 * 60_000, max: 100 }));
// Tighten common abuse targets.
app.use('/api/users/anonymous', rateLimit({ windowMs: 60_000, max: 40 }));
app.use('/api/access', rateLimit({ windowMs: 60_000, max: 90 }));
app.use('/api/threads', rateLimit({ windowMs: 60_000, max: 90 }));
app.use('/api/recommendations', rateLimit({ windowMs: 60_000, max: 60 }));
app.use('/api/search', rateLimit({ windowMs: 60_000, max: 90 }));
app.use('/api/agent', rateLimit({ windowMs: 60_000, max: 75 }));

const sessionManager = new RealtimeSessionManager(io, redis.data);
registerSocketEvents(io, sessionManager);

const { booksModule } = bootstrapFeatureModules();

// Initialize BookFriend integration services
const bookfriendConfig = getBookfriendConfig();
const bookfriendClient = new BookfriendClient(bookfriendConfig);
const bookfriendHealthMonitor = new BookfriendHealthMonitor({ threshold: bookfriendConfig.healthFailureThreshold });
// The gateway expects a structured logger (logger.info/warn/error); `log` is a
// bare function, so adapt it to that interface.
const bookfriendLogger = { info: log, warn: log, error: log };
const bookfriendGateway = new BookfriendGatewayService({ client: bookfriendClient, healthMonitor: bookfriendHealthMonitor, logger: bookfriendLogger });

app.locals.bookfriendGateway = bookfriendGateway;

log('[SERVER] BookFriend gateway initialized', {
  baseUrl: bookfriendConfig.baseUrl,
  timeoutMs: bookfriendConfig.timeoutMs,
  retryCount: bookfriendConfig.retryCount,
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/books', booksModule.router);
app.use('/api', requireDatabase({ status: 503, feature: 'Threads' }), buildBookThreadsRoutes());
app.use('/api/agent', agentRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/session', requireDatabase({ feature: 'Realtime sessions' }), buildSessionRoutes(sessionManager));
// '/api/meet' is the current path; '/api/matchmaking' is retained for older clients.
// Both mount the same router -- they were previously two identical builder modules.
app.use('/api/matchmaking', requireDatabase({ feature: 'Meet' }), buildMatchmakingRoutes(sessionManager));
app.use('/api/meet', requireDatabase({ feature: 'Meet' }), buildMatchmakingRoutes(sessionManager));
app.use('/api/recommendations', recommendationsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/reading', readingRoutes);

app.get('/api/health', (req, res) => {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    return res.status(dbConnected ? 200 : 503).json({
      status: dbConnected ? 'ok' : 'unavailable',
      db: dbConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    });
  } catch (_ERROR) {
    return res.status(503).json({
      status: 'unavailable',
      db: 'unknown',
    });
  }
});

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 10000;

httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${PORT} is already in use. Is the server already running?`);
    process.exit(1);
  }

  console.error('[SERVER] Fatal error:', error);
  process.exit(1);
});

try {
  await connectDB();
} catch (error) {
  console.error('[SERVER] Failed startup database validation:', error?.message || error);
  process.exit(1);
}

httpServer.listen(PORT, () => {
  log(`[SERVER] Nexus core listening on port ${PORT}`);
});
