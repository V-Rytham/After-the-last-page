import { buildSafeErrorBody } from '../utils/runtime.js';

export const notFound = (req, res) => {
  res.status(404).json({ message: 'Not found.' });
};

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = Number(err?.statusCode || err?.status || 500);
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  const source = String(err?.source || 'backend').trim();
  const service = String(err?.service || 'nexus-core').trim();
  const requestId = req?.id || req?.headers?.['x-request-id'] || null;

  console.error('[ERROR]', {
    status: safeStatus,
    source,
    service,
    requestId,
    method: req?.method,
    path: req?.originalUrl,
    message: err?.message,
    stack: err?.stack,
  });

  return res.status(safeStatus).json({
    ...buildSafeErrorBody(err?.message || 'Request failed.', err),
    error: true,
    source,
    service,
    status: safeStatus,
    requestId,
  });
};
