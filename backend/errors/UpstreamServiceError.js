/**
 * Structured error for upstream microservice failures.
 * Provides clear categorization of failure types for proper handling.
 */
export class UpstreamServiceError extends Error {
  constructor(options = {}) {
    const {
      service = 'unknown',
      status = 500,
      message = 'Upstream service error',
      category = 'UNKNOWN_ERROR',
      originalError = null,
      requestId = null,
    } = options;

    super(message);
    this.name = 'UpstreamServiceError';
    this.service = service;
    this.status = status;
    this.category = category;
    this.originalError = originalError;
    this.requestId = requestId;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Specific upstream error categories based on HTTP status and response content.
 */
export const UPSTREAM_ERROR_CATEGORIES = Object.freeze({
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  BOOK_NOT_FOUND: 'BOOK_NOT_FOUND',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  UPSTREAM_5XX: 'UPSTREAM_5XX',
  NETWORK_ERROR: 'NETWORK_ERROR',
});

/**
 * Categorize errors from BookFriend service.
 */
export const categorizeUpstreamError = (error, statusCode) => {
  if (!error || !statusCode) {
    return UPSTREAM_ERROR_CATEGORIES.UNKNOWN_ERROR;
  }

  const message = String(error?.message || '').toLowerCase();

  if (statusCode === 404) {
    if (message.includes('session')) {
      return UPSTREAM_ERROR_CATEGORIES.SESSION_NOT_FOUND;
    }
    if (message.includes('book')) {
      return UPSTREAM_ERROR_CATEGORIES.BOOK_NOT_FOUND;
    }
    return UPSTREAM_ERROR_CATEGORIES.INVALID_REQUEST;
  }

  if (statusCode === 400 || statusCode === 422) {
    return UPSTREAM_ERROR_CATEGORIES.INVALID_REQUEST;
  }

  if (statusCode >= 500) {
    return UPSTREAM_ERROR_CATEGORIES.UPSTREAM_5XX;
  }

  if (statusCode >= 503) {
    return UPSTREAM_ERROR_CATEGORIES.UPSTREAM_UNAVAILABLE;
  }

  return UPSTREAM_ERROR_CATEGORIES.UNKNOWN_ERROR;
};

export const isNetworkError = (error) => {
  if (!error) return false;

  return (
    error.name === 'TypeError' ||
    error.name === 'AbortError' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ETIMEDOUT' ||
    error.message?.includes('fetch failed')
  );
};
