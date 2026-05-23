import test from 'node:test';
import assert from 'node:assert/strict';
import { BookfriendClient } from '../services/bookfriendClient.js';
import { UpstreamServiceError, UPSTREAM_ERROR_CATEGORIES } from '../errors/UpstreamServiceError.js';

test('BookfriendClient falls back when global fetch is unavailable', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = undefined;

    const client = new BookfriendClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
      maxRetries: 0,
    });

    await assert.rejects(
      () => client.checkHealth({ requestId: 'test_no_global_fetch' }),
      (error) => {
        assert.ok(error instanceof UpstreamServiceError);
        assert.ok(
          error.category === UPSTREAM_ERROR_CATEGORIES.NETWORK_ERROR
            || error.category === UPSTREAM_ERROR_CATEGORIES.UPSTREAM_TIMEOUT,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

