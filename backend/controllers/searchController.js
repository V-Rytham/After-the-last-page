import { runGlobalSearch } from '../services/searchService.js';
import { createMicroserviceClient } from '../services/microserviceProxy.js';
import { log } from '../utils/logger.js';

const searchClient = createMicroserviceClient({
  envBaseUrlKey: 'SEARCH_SERVICE_URL',
  envTimeoutMsKey: 'SEARCH_SERVICE_TIMEOUT_MS',
  envEnabledKey: 'SEARCH_SERVICE_ENABLED',
  fallbackEnabled: true,
});

export const getSearch = async (req, res) => {
  try {
    log('Incoming search query:', req.query);
    const q = String(req.query?.q || '').trim();
    if (!q) {
      return res.json({ books: [] });
    }

    if (searchClient.isEnabled()) {
      try {
        log('[SEARCH] Delegating query to search microservice', { q });
        const payload = await searchClient.get(`/api/search?q=${encodeURIComponent(q)}`);
        const books = Array.isArray(payload?.books) ? payload.books : [];
        log('[SEARCH] Search microservice response received', { q, books: books.length });
        return res.json({ books });
      } catch (error) {
        if (!error?.allowLocalFallback) throw error;
        log('[SEARCH] Search microservice failed; using local fallback', { q, reason: error?.message || 'unknown' });
      }
    }

    const books = await runGlobalSearch({ q });
    log('[SEARCH] Local aggregated search completed', { q, books: Array.isArray(books) ? books.length : 0 });
    return res.json({ books });
  } catch (error) {
    console.error('[SEARCH] Failed:', error?.message || error);
    return res.status(500).json({ error: 'Search failed.' });
  }
};
