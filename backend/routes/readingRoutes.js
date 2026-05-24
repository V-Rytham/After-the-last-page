import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { getRecentReadingActivity, upsertReadingProgress } from '../controllers/readingController.js';

const router = express.Router();
router.get('/recent', requireAuth, getRecentReadingActivity);
router.post('/progress', requireAuth, upsertReadingProgress);

export default router;
