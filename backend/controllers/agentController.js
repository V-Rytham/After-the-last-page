import crypto from 'node:crypto';
import { validateStartPayload, validateMessagePayload, validateEndPayload } from '../src/integrations/bookfriend/validators/agentValidators.js';
import { BookfriendError, ValidationError } from '../src/integrations/bookfriend/errors/BookfriendErrors.js';

const sendError = (res, error, requestId) => {
  const status = error instanceof BookfriendError ? error.status : (error.message === 'Session not found for user' ? 404 : 502);
  const code = error instanceof BookfriendError ? error.code : 'BOOKFRIEND_GATEWAY_ERROR';
  return res.status(status).json({ error: error.message, code, requestId, safe: true });
};

export const startAgentSession = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();
  try {
    validateStartPayload(req.body);
    const userId = req.user?._id?.toString() || req.user?.anonymousId;
    if (!userId) throw new ValidationError('Authentication required');
    const data = await req.app.locals.bookfriendGateway.start({ userId, body: req.body, requestId });
    return res.status(201).json({ ...data, requestId });
  } catch (error) { return sendError(res, error, requestId); }
};

export const sendAgentMessage = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();
  try {
    validateMessagePayload(req.body);
    const userId = req.user?._id?.toString() || req.user?.anonymousId;
    if (!userId) throw new ValidationError('Authentication required');
    const data = await req.app.locals.bookfriendGateway.message({ userId, body: req.body, requestId });
    return res.json({ ...data, requestId });
  } catch (error) { return sendError(res, error, requestId); }
};

export const endAgentSession = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();
  try {
    validateEndPayload(req.body);
    const userId = req.user?._id?.toString() || req.user?.anonymousId;
    if (!userId) throw new ValidationError('Authentication required');
    const data = await req.app.locals.bookfriendGateway.end({ userId, body: req.body, requestId });
    return res.json({ ...data, requestId });
  } catch (error) { return sendError(res, error, requestId); }
};

export const inspectAgentSession = async (req, res) => {
  return res.status(410).json({ message: 'Deprecated. Use /api/agent/health.' });
};

export const getAgentHealth = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();
  const data = await req.app.locals.bookfriendGateway.health(requestId);
  return res.status(data.ok ? 200 : 503).json({ ...data, requestId });
};
