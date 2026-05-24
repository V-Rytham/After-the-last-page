import { fetch as undiciFetch } from 'undici';
import { BookfriendUnavailableError, ServiceTimeoutError, SessionExpiredError, ValidationError } from '../errors/BookfriendErrors.js';

export class BookfriendClient {
  constructor(config) { this.config = config; }

  async request(path, { method = 'GET', body, requestId }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await (globalThis.fetch || undiciFetch)(`${this.config.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-request-id': requestId || '' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404 && String(data?.message || '').toLowerCase().includes('session')) throw new SessionExpiredError(data?.message || 'Session not found');
        if (res.status === 400 || res.status === 422) throw new ValidationError(data?.message || 'Invalid request', data);
        throw new BookfriendUnavailableError(data?.message || `BookFriend failed with ${res.status}`, { status: res.status });
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new ServiceTimeoutError(`Timed out after ${this.config.timeoutMs}ms`);
      if (error instanceof Error && ['SessionExpiredError', 'ValidationError', 'BookfriendUnavailableError'].includes(error.name)) throw error;
      throw new BookfriendUnavailableError('Network error connecting to BookFriend', { cause: error?.message });
    } finally {
      clearTimeout(timeout);
    }
  }

  health(requestId) { return this.request('/health', { method: 'GET', requestId }); }
  start(payload, requestId) { return this.request('/agent/start', { method: 'POST', body: payload, requestId }); }
  message(payload, requestId) { return this.request('/agent/message', { method: 'POST', body: payload, requestId }); }
  end(payload, requestId) { return this.request('/agent/end', { method: 'POST', body: payload, requestId }); }
  status(gutenbergId, requestId) { return this.request(`/agent/book/${gutenbergId}/status`, { method: 'GET', requestId }); }
}
