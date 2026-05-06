import { createMicroserviceClient } from '../services/microserviceProxy.js';

const recommendationsClient = createMicroserviceClient({
  envBaseUrlKey: 'RECOMMENDATIONS_SERVICE_URL',
  envTimeoutMsKey: 'RECOMMENDATIONS_SERVICE_TIMEOUT_MS',
  envEnabledKey: 'RECOMMENDATIONS_SERVICE_ENABLED',
  fallbackEnabled: false,
});

const normalizeGenre = (value) => String(value || '').trim().toLowerCase();

export const postRecommendations = async (req, res) => {
  try {
    const rawGenres = Array.isArray(req.body?.genres) ? req.body.genres : [];
    const normalized = Array.from(new Set(rawGenres.map(normalizeGenre).filter(Boolean)));

    if (normalized.length === 0) {
      return res.status(400).json({ message: 'genres must be a non-empty array.' });
    }

    if (!recommendationsClient.isEnabled()) {
      return res.status(503).json({
        message: 'Recommendations service unavailable.',
        code: 'RECOMMENDATIONS_SERVICE_DISABLED',
      });
    }

    const delegated = await recommendationsClient.post('/api/recommendations', { genres: normalized });
    return res.json(delegated);
  } catch (error) {
    const statusCode = Number.isFinite(error?.statusCode) ? Number(error.statusCode) : 503;
    return res.status(statusCode).json({
      message: String(error?.message || 'Failed to fetch recommendations.'),
      code: 'RECOMMENDATIONS_SERVICE_ERROR',
      details: error?.payload || null,
    });
  }
};

export const getRecommendationsForYou = async (req, res) => {
  try {
    if (!recommendationsClient.isEnabled()) {
      return res.status(503).json({
        message: 'Recommendations service unavailable.',
        code: 'RECOMMENDATIONS_SERVICE_DISABLED',
      });
    }

    const response = await recommendationsClient.get('/api/recommendations/for-you', {
      Authorization: req.headers.authorization || '',
      'x-book-action-name': req.headers['x-book-action-name'] || '',
    });
    return res.json(response);
  } catch (error) {
    const statusCode = Number.isFinite(error?.statusCode) ? Number(error.statusCode) : 503;
    return res.status(statusCode).json({
      message: String(error?.message || 'Failed to fetch personalized recommendations.'),
      code: 'RECOMMENDATIONS_SERVICE_ERROR',
      details: error?.payload || null,
    });
  }
};

export const postRecommendationClick = async (req, res) => {
  try {
    if (!recommendationsClient.isEnabled()) {
      return res.status(503).json({
        message: 'Recommendations service unavailable.',
        code: 'RECOMMENDATIONS_SERVICE_DISABLED',
      });
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
