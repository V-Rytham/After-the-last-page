import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { attachIdentity } from '../middleware/identityMiddleware.js';
import { createMatchmakingController } from '../controllers/matchmakingController.js';

export const buildMeetRoutes = (sessionManager) => {
  const router = express.Router();
  const controller = createMatchmakingController(sessionManager);

  router.post('/join', requireAuth, attachIdentity, controller.join);
  router.post('/leave', requireAuth, attachIdentity, controller.leave);

  return router;
};
