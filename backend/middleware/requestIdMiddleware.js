import crypto from 'node:crypto';

/**
 * Middleware to attach request ID for correlation tracking.
 * Enables tracing of requests through the entire system.
 */
export const requestIdMiddleware = (req, res, next) => {
  // Use X-Request-ID header if provided, otherwise generate new ID
  req.requestId = req.get('X-Request-ID') || crypto.randomUUID();

  // Attach to response headers for client reference
  res.setHeader('X-Request-ID', req.requestId);

  next();
};
