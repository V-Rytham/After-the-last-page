import {
  UpstreamServiceError,
  UPSTREAM_ERROR_CATEGORIES,
  categorizeUpstreamError,
  isNetworkError,
} from '../errors/UpstreamServiceError.js';
import { fetch as undiciFetch } from 'undici';
import { log } from '../utils/logger.js';
import { isProd } from '../utils/runtime.js';

/**
 * Centralized BookFriend microservice client.
 *
 * Handles:
 * - All BookFriend communication
 * - Structured error propagation
 * - Request correlation tracing
 * - Timeout and retry logic
 * - Observability logging
 *
 * NO fallback logic. NO local recovery.
 * Failures surface explicitly.
 */
export class BookfriendClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || '').trim() || 'http://127.0.0.1:5050';
    this.timeoutMs = Number(options.timeoutMs) || 60_000;
    this.maxRetries = options.maxRetries || 2;
  }

  /**
   * Make a request to BookFriend service.
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g. '/agent/start')
   * @param {object} payload - Request body
   * @param {object} options - Additional options (requestId, retryCount, etc.)
   * @returns {Promise<object>} Response data
   * @throws {UpstreamServiceError}
   */
  async request(method, path, payload, options = {}) {
    const { requestId = null, retryCount = 0, userId = null, bookId = null, sessionId = null } = options;

    const targetUrl = `${this.baseUrl}${path}`;

    log('[BOOKFRIEND_CLIENT] Request initiated', {
      requestId,
      method,
      path,
      targetUrl,
      userId,
      bookId,
      sessionId,
      retryCount,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId || '',
        'X-User-ID': userId || '',
        'X-Book-ID': bookId || '',
        'X-Session-ID': sessionId || '',
      };

      const init = {
        method: String(method || 'GET').toUpperCase(),
        headers,
        signal: controller.signal,
      };

      if (init.method !== 'GET' && init.method !== 'HEAD') {
        init.body = JSON.stringify(payload || {});
      }

      const fetchImpl = globalThis.fetch || undiciFetch;
      const response = await fetchImpl(targetUrl, init);

      let data = {};
      try {
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          data = await response.json();
        }
      } catch {
        data = { message: 'Invalid JSON response from BookFriend' };
      }

      if (!response.ok) {
        const category = categorizeUpstreamError(data, response.status);
        const upstreamError = new UpstreamServiceError({
          service: 'bookfriend-agent',
          status: response.status,
          message: data?.message || `BookFriend returned ${response.status}`,
          category,
          requestId,
        });

        log('[BOOKFRIEND_CLIENT] Request failed', {
          requestId,
          method,
          path,
          status: response.status,
          category,
          message: data?.message,
          userId,
          bookId,
          sessionId,
          retryCount,
        });

        throw upstreamError;
      }

      log('[BOOKFRIEND_CLIENT] Request succeeded', {
        requestId,
        method,
        path,
        status: response.status,
        userId,
        bookId,
        sessionId,
        retryCount,
      });

      return data;
    } catch (error) {
      // Handle network errors
      if (isNetworkError(error)) {
        const upstreamError = new UpstreamServiceError({
          service: 'bookfriend-agent',
          status: 503,
          message: 'BookFriend service is unavailable (network error)',
          category: UPSTREAM_ERROR_CATEGORIES.NETWORK_ERROR,
          originalError: error,
          requestId,
        });

        log('[BOOKFRIEND_CLIENT] Network error', {
          requestId,
          method,
          path,
          error: error.message,
          code: error.code,
          userId,
          bookId,
          sessionId,
          retryCount,
        });

        throw upstreamError;
      }

      // Handle timeout
      if (error.name === 'AbortError') {
        const upstreamError = new UpstreamServiceError({
          service: 'bookfriend-agent',
          status: 504,
          message: `BookFriend request timed out after ${this.timeoutMs}ms`,
          category: UPSTREAM_ERROR_CATEGORIES.UPSTREAM_TIMEOUT,
          originalError: error,
          requestId,
        });

        log('[BOOKFRIEND_CLIENT] Timeout', {
          requestId,
          method,
          path,
          timeoutMs: this.timeoutMs,
          userId,
          bookId,
          sessionId,
          retryCount,
        });

        throw upstreamError;
      }

      // Re-throw if already categorized
      if (error instanceof UpstreamServiceError) {
        throw error;
      }

      // Catch-all for unexpected errors
      const upstreamError = new UpstreamServiceError({
        service: 'bookfriend-agent',
        status: 502,
        message: error.message || 'Unexpected error communicating with BookFriend',
        category: UPSTREAM_ERROR_CATEGORIES.UNKNOWN_ERROR,
        originalError: error,
        requestId,
      });

      log('[BOOKFRIEND_CLIENT] Unexpected error', {
        requestId,
        method,
        path,
        error: error.message,
        stack: error.stack,
        userId,
        bookId,
        sessionId,
      });

      throw upstreamError;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Start a new BookFriend session.
   */
  async startSession(userId, bookId, options = {}) {
    return this.request('POST', '/agent/start', { user_id: userId, book_id: bookId, chapter_progress: options.chapterProgress }, {
      requestId: options.requestId,
      userId,
      bookId,
    });
  }

  /**
   * Send a message to BookFriend session.
   */
  async sendMessage(sessionId, message, options = {}) {
    return this.request(
      'POST',
      '/agent/message',
      { session_id: sessionId, message, chapter_progress: options.chapterProgress },
      {
        requestId: options.requestId,
        userId: options.userId,
        bookId: options.bookId,
        sessionId,
      },
    );
  }

  /**
   * End a BookFriend session.
   */
  async endSession(sessionId, options = {}) {
    return this.request('POST', '/agent/end', { session_id: sessionId }, {
      requestId: options.requestId,
      userId: options.userId,
      bookId: options.bookId,
      sessionId,
    });
  }

  /**
   * Check BookFriend service health.
   */
  async checkHealth(options = {}) {
    return this.request('GET', '/health', {}, {
      requestId: options.requestId,
    });
  }
}

/**
 * Create a configured BookFriend client from environment variables.
 */
export const createBookfriendClient = () => {
  const baseUrl = String(process.env.BOOKFRIEND_SERVER_URL || '').trim() || 'http://127.0.0.1:5050';
  const timeoutMs = Number(process.env.BOOKFRIEND_SERVICE_TIMEOUT_MS || 60_000);

  if (!isProd() && !baseUrl) {
    log('[BOOKFRIEND_CLIENT] No BOOKFRIEND_SERVER_URL configured, using local default');
  }

  return new BookfriendClient({ baseUrl, timeoutMs });
};
