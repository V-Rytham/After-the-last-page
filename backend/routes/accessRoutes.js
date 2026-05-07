import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkAccess, checkAccessBatch } from '../controllers/accessController.js';

const router = express.Router();

router.get('/check', protect, checkAccess);
router.post('/check-batch', protect, checkAccessBatch);

export default router;
