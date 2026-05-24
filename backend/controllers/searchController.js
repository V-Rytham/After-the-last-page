import { createMicroserviceClient } from '../services/microserviceProxy.js';

const searchClient = createMicroserviceClient({
  envBaseUrlKey: 'SEARCH_SERVICE_URL',
  envTimeoutMsKey: 'SEARCH_SERVICE_TIMEOUT_MS',
  envEnabledKey: 'SEARCH_SERVICE_ENABLED',
});

export const getSearch = async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim();
    if (!q) {
      return res.json({ success: true, books: [] });
    }

    if (!searchClient.isEnabled()) {
      return res.json({ success: true, books: [] });
    }

    const payload = await searchClient.get(`/api/search?q=${encodeURIComponent(q)}`);
    const books = Array.isArray(payload?.books) ? payload.books : [];
    return res.json({ success: true, books });
  } catch (error) {
    return res.json({
      success: true,
      books: [],
      fallback: true,
      message: String(error?.message || 'Search failed.'),
      code: 'SEARCH_SERVICE_ERROR',
    });
  }
};
