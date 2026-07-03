import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { AUTH_COOKIE_NAME } from '../utils/authCookies.js';
import { isDegradedMode } from '../utils/degradedMode.js';

const toCleanString = (value, maxLen = 80) => String(value || '').trim().slice(0, maxLen);

const normalizeDisplayName = (value) => {
  const cleaned = toCleanString(value, 60);
  return cleaned || `Reader${Math.floor(1000 + Math.random() * 9000)}`;
};

const inferUserIdFromRequest = (req) => {
  const fromHeader = toCleanString(req.headers['x-user-id']);
  const fromBody = toCleanString(req.body?.userId);
  const fromQuery = toCleanString(req.query?.userId);
  return fromHeader || fromBody || fromQuery || randomUUID();
};

const inferDisplayNameFromRequest = (req) => {
  const fromHeader = toCleanString(req.headers['x-display-name'], 60);
  const fromBody = toCleanString(req.body?.displayName, 60);
  const fromQuery = toCleanString(req.query?.displayName, 60);
  return normalizeDisplayName(fromHeader || fromBody || fromQuery);
};

export const attachIdentity = (req, _res, next) => {
  const authenticatedUserId = toCleanString(req.user?._id || req.user?.id);
  const authenticatedDisplayName = normalizeDisplayName(
    req.user?.displayName || req.user?.username || req.user?.name || req.user?.email,
  );

  req.identity = {
    userId: authenticatedUserId || inferUserIdFromRequest(req),
    displayName: authenticatedUserId ? authenticatedDisplayName : inferDisplayNameFromRequest(req),
  };
  next();
};

const parseCookieHeader = (header = '') => String(header || '')
  .split(';')
  .map((part) => part.trim())
  .filter(Boolean)
  .reduce((cookies, part) => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) return cookies;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});

const getSocketToken = (socket) => {
  const authToken = toCleanString(socket.handshake?.auth?.token, 2000);
  if (authToken) return authToken;

  const bearer = String(socket.handshake?.headers?.authorization || '').trim();
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim();
  }

  const cookies = parseCookieHeader(socket.handshake?.headers?.cookie);
  return toCleanString(cookies[AUTH_COOKIE_NAME], 2000);
};

export const requireSocketAuth = async (socket, next) => {
  const token = getSocketToken(socket);
  if (!token) {
    return next(new Error('Not authorized, no token'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const tokenUserId = toCleanString(decoded?.id || decoded?._id);
    if (!tokenUserId) {
      return next(new Error('Not authorized, token failed'));
    }

    let user = null;
    if (isDegradedMode()) {
      user = {
        _id: tokenUserId,
        anonymousId: decoded?.anonymousId || '',
        isAnonymous: Boolean(decoded?.isAnonymous),
      };
    } else {
      user = await User.findById(tokenUserId).select('-password -otpHash').lean();
    }

    if (!user) {
      return next(new Error('Not authorized, user not found'));
    }

    socket.user = user;
    socket.userId = tokenUserId;
    socket.displayName = normalizeDisplayName(user.displayName || user.username || user.name || user.email || decoded?.displayName);
    return next();
  } catch {
    return next(new Error('Not authorized, token failed'));
  }
};

export const resolveSocketIdentity = (socket) => {
  const fromAuthId = toCleanString(socket.handshake?.auth?.userId);
  const fromQueryId = toCleanString(socket.handshake?.query?.userId);
  const fromHeaderId = toCleanString(socket.handshake?.headers?.['x-user-id']);

  const fromAuthName = toCleanString(socket.handshake?.auth?.displayName, 60);
  const fromQueryName = toCleanString(socket.handshake?.query?.displayName, 60);
  const fromHeaderName = toCleanString(socket.handshake?.headers?.['x-display-name'], 60);

  return {
    userId: fromAuthId || fromQueryId || fromHeaderId || randomUUID(),
    displayName: normalizeDisplayName(fromAuthName || fromQueryName || fromHeaderName),
  };
};
