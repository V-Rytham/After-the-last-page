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
      return res.json({ books: [] });
    }

    if (!searchClient.isEnabled()) {
      return res.status(503).json({
        message: 'Search service is disabled or not configured.',
        code: 'SEARCH_SERVICE_UNAVAILABLE',
      });
    }

    const payload = await searchClient.get(`/api/search?q=${encodeURIComponent(q)}`);
    const books = Array.isArray(payload?.books) ? payload.books : [];
    return res.json({ books });
  } catch (error) {
    const statusCode = Number.isFinite(error?.statusCode) ? Number(error.statusCode) : 503;
    return res.status(statusCode).json({
      message: String(error?.message || 'Search failed.'),
      code: 'SEARCH_SERVICE_ERROR',
      details: error?.payload || null,
    });
  }
};
