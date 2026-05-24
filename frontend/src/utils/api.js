import axios from 'axios';
import { getApiBaseUrl } from './serviceUrls';
import { getOrCreateIdentity } from './identity';
import { getStoredToken } from './auth';

const baseURL = getApiBaseUrl();
let rateLimitedUntil = 0;

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;
  const raw = String(retryAfterHeader).trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const api = axios.create({
  baseURL,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

const isHealthRequest = (url = '') => /\/health(?:\?.*)?$/i.test(String(url || ''));

// Add interceptor to inject token if we have one
api.interceptors.request.use(
  async (config) => {
    if (Date.now() < rateLimitedUntil) {
      await sleep(rateLimitedUntil - Date.now());
    }

    const token = getStoredToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    if (!isHealthRequest(config?.url)) {
      const identity = getOrCreateIdentity();
      if (identity?.userId) {
        config.headers['X-User-Id'] = identity.userId;
      }
      if (identity?.displayName) {
        config.headers['X-Display-Name'] = identity.displayName;
      }
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const statusCode = Number(error?.response?.status || 0) || null;
    if (statusCode === 429) {
      const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.['retry-after']);
      const fallbackDelayMs = 4000;
      const waitMs = retryAfterMs ?? fallbackDelayMs;
      rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + waitMs);
    }

    const isTimeout = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''));
    const mappedMessage = statusCode === 504
      ? 'This book is large and taking longer than expected.'
      : (isTimeout ? 'Still loading, please retry.' : null);
    const message = mappedMessage
      || error?.response?.data?.error?.message
      || error?.response?.data?.message
      || error?.message
      || 'Request failed.';

    const requestUrl = `${error?.config?.baseURL || ''}${error?.config?.url || ''}`;

    return Promise.reject({
      ...error,
      uiMessage: message,
      statusCode,
      requestUrl,
    });
  },
);

export default api;
