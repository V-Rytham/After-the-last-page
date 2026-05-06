const TOKEN_KEY = 'token';
const USER_KEY = 'currentUser';

const readJson = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const getStoredToken = () => window.localStorage.getItem(TOKEN_KEY);

export const getStoredUser = () => {
  const rawUser = window.localStorage.getItem(USER_KEY);
  const parsed = readJson(rawUser);
  return parsed && typeof parsed === 'object' ? parsed : null;
};

export const saveAuthSession = (payload) => {
  const effectivePayload = payload?.user && typeof payload.user === 'object'
    ? { ...(payload.user || {}), token: payload?.token }
    : (payload || {});

  const normalizedToken = String(effectivePayload?.token || '').trim();
  const { token: _omitToken, ...user } = effectivePayload || {};

  if (normalizedToken) {
    window.localStorage.setItem(TOKEN_KEY, normalizedToken);
  } else if (window.localStorage.getItem(TOKEN_KEY)) {
    window.localStorage.removeItem(TOKEN_KEY);
  }

  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  window.localStorage.setItem('anonId', user?.anonymousId || '');
  return user;
};

export const clearAuthSession = () => {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  window.localStorage.removeItem('anonId');
};

export const updateStoredUser = (patch) => {
  const current = getStoredUser();
  if (!current) return null;

  const nextUser = { ...current, ...(patch || {}) };
  window.localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
  return nextUser;
};

