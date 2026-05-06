import { buildRecommendations } from '../services/recommendationsService.js';
import { createMicroserviceClient } from '../services/microserviceProxy.js';
import {
  invalidateRecommendationCacheV2,
  mergeAndRankRecommendations,
  trackRecommendationClickV2,
} from '../services/recommendationEngineV2.js';

const recommendationsClient = createMicroserviceClient({
  envBaseUrlKey: 'RECOMMENDATIONS_SERVICE_URL',
  envTimeoutMsKey: 'RECOMMENDATIONS_SERVICE_TIMEOUT_MS',
  envEnabledKey: 'RECOMMENDATIONS_SERVICE_ENABLED',
  fallbackEnabled: true,
});

const normalizeGenre = (value) => String(value || '').trim().toLowerCase();

export const postRecommendations = async (req, res) => {
  try {
    const rawGenres = Array.isArray(req.body?.genres) ? req.body.genres : [];
    const normalized = Array.from(new Set(rawGenres.map(normalizeGenre).filter(Boolean)));

    if (normalized.length === 0) {
      return res.status(400).json({ message: 'genres must be a non-empty array.' });
    }

    if (recommendationsClient.isEnabled()) {
      try {
        const delegated = await recommendationsClient.post('/api/recommendations', { genres: normalized });
        return res.json(delegated);
      } catch (error) {
        console.warn('[RECOMMENDATIONS] Remote service unavailable, falling back locally:', error?.message || error);
      }
    }

    const result = await buildRecommendations({ genres: normalized });

    return res.json({
      books: result.books,
      personalized: true,
    });
  } catch (error) {
    console.error('[RECOMMENDATIONS] Failed:', error?.message || error);
    return res.status(500).json({ message: 'Failed to generate recommendations.' });
  }
};

export const getRecommendationsForYou = async (req, res) => {
  try {
    const userId = String(req.user?._id || '').trim();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized.' });
    }

    const actionName = String(req.headers['x-book-action-name'] || '').trim().toLowerCase();
    if (actionName === 'add' || actionName === 'remove') {
      invalidateRecommendationCacheV2(userId);
    }

    const response = await mergeAndRankRecommendations(userId);
    return res.json(response);
  } catch (error) {
    console.error('[RECOMMENDATIONS_V2] Failed:', error?.message || error);
    return res.status(500).json({ message: 'Failed to fetch personalized recommendations.' });
  }
};

export const postRecommendationClick = async (req, res) => {
  try {
    const userId = String(req.user?._id || '').trim();
    const bookId = String(req.body?.bookId || '').trim();

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized.' });
    }

    if (!bookId) {
      return res.status(400).json({ message: 'bookId is required.' });
    }

    trackRecommendationClickV2({ userId, bookId });
    return res.status(204).send();
  } catch {
    return res.status(500).json({ message: 'Failed to track recommendation click.' });
  }
};
