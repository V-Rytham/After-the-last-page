import { createMicroserviceClient } from '../services/microserviceProxy.js';
import { defaultBooks } from '../seed/defaultBooks.js';

const recommendationsClient = createMicroserviceClient({
  envBaseUrlKey: 'RECOMMENDATIONS_SERVICE_URL',
  envTimeoutMsKey: 'RECOMMENDATIONS_SERVICE_TIMEOUT_MS',
  envEnabledKey: 'RECOMMENDATIONS_SERVICE_ENABLED',
});

const normalizeGenre = (value) => String(value || '').trim().toLowerCase();
const normalizeLimit = (value, { min = 1, max = 50 } = {}) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
};

const serviceUnavailableError = (message) => ({
  message,
  code: 'RECOMMENDATIONS_SERVICE_UNAVAILABLE',
});

const toFallbackRecommendation = (book) => {
  const gutenbergId = Number(book?.gutenbergId);
  if (!Number.isFinite(gutenbergId) || gutenbergId <= 0) return null;
  return {
    id: `gutenberg:${gutenbergId}`,
    gutenbergId,
    title: String(book?.title || 'Untitled'),
    author: String(book?.author || 'Unknown author'),
    reason: 'curated-fallback',
  };
};

const buildFallbackRecommendations = ({ genres = [], limit = 12 } = {}) => {
  const normalizedGenres = genres.map((genre) => normalizeGenre(genre)).filter(Boolean);
  const filtered = normalizedGenres.length === 0
    ? defaultBooks
    : defaultBooks.filter((book) => {
        const bookGenres = Array.isArray(book?.tags) ? book.tags.map((genre) => normalizeGenre(genre)) : [];
        return normalizedGenres.some((genre) => bookGenres.includes(genre));
      });

  const pool = (filtered.length > 0 ? filtered : defaultBooks)
    .map(toFallbackRecommendation)
    .filter(Boolean);

  return pool.slice(0, limit);
};

export const postRecommendations = async (req, res) => {
  try {
    const rawGenres = Array.isArray(req.body?.genres) ? req.body.genres : [];
    const normalized = Array.from(new Set(rawGenres.map(normalizeGenre).filter(Boolean)));
    const limit = normalizeLimit(req.body?.limit);

    if (normalized.length === 0) {
      return res.status(400).json({ message: 'genres must be a non-empty array.' });
    }

    if (!recommendationsClient.isEnabled()) {
      return res.status(200).json({
        success: true,
        books: buildFallbackRecommendations({ genres: normalized, limit: limit || 12 }),
        personalized: false,
        fallback: true,
        code: serviceUnavailableError('Recommendations service is disabled or not configured.').code,
      });
    }

    const delegated = await recommendationsClient.post('/api/recommendations', { genres: normalized, limit });
    const books = Array.isArray(delegated?.books) ? delegated.books : [];
    if (books.length > 0) return res.json(delegated);

    return res.status(200).json({
      success: true,
      books: buildFallbackRecommendations({ genres: normalized, limit: limit || 12 }),
      personalized: false,
      fallback: true,
    });
  } catch (error) {
    return res.status(200).json({
      success: true,
      books: buildFallbackRecommendations({ genres: req.body?.genres || [], limit: normalizeLimit(req.body?.limit) || 12 }),
      personalized: false,
      fallback: true,
      message: String(error?.message || 'Failed to fetch recommendations.'),
      code: 'RECOMMENDATIONS_SERVICE_ERROR',
    });
  }
};

export const getRecommendationsForYou = async (req, res) => {
  try {
    if (!recommendationsClient.isEnabled()) {
      return res.status(200).json({
        success: true,
        recommendations: buildFallbackRecommendations({ limit: 12 }),
        personalized: false,
        fallback: true,
        code: serviceUnavailableError('Recommendations service is disabled or not configured.').code,
      });
    }

    const response = await recommendationsClient.get('/api/recommendations/for-you', {
      Authorization: req.headers.authorization || '',
      'x-book-action-name': req.headers['x-book-action-name'] || '',
    });
    return res.json(response);
  } catch (error) {
    return res.status(200).json({
      success: true,
      recommendations: buildFallbackRecommendations({ limit: 12 }),
      personalized: false,
      fallback: true,
      message: String(error?.message || 'Failed to fetch personalized recommendations.'),
      code: 'RECOMMENDATIONS_SERVICE_ERROR',
    });
  }
};

export const postRecommendationClick = async (req, res) => {
  try {
    if (!recommendationsClient.isEnabled()) {
      return res.status(503).json(serviceUnavailableError('Recommendations service is disabled or not configured.'));
    }

    await recommendationsClient.post('/api/recommendations/for-you/click', req.body || {}, {
      Authorization: req.headers.authorization || '',
    });
    return res.status(204).send();
  } catch (error) {
    const statusCode = Number.isFinite(error?.statusCode) ? Number(error.statusCode) : 503;
    return res.status(statusCode).json({
      message: String(error?.message || 'Failed to track recommendation click.'),
      code: 'RECOMMENDATIONS_SERVICE_ERROR',
      details: error?.payload || null,
    });
  }
};
