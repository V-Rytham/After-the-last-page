import express from 'express';
import {
  startAgentSession,
  sendAgentMessage,
  endAgentSession,
  inspectAgentSession,
  getAgentHealth,
} from '../controllers/agentController.js';
import { protectFlexible } from '../middleware/flexibleAuth.js';

const router = express.Router();
router.get('/health', getAgentHealth);
router.post('/start', protectFlexible, startAgentSession);
router.post('/message', protectFlexible, sendAgentMessage);
router.post('/end', protectFlexible, endAgentSession);
router.get('/session/:sessionId', protectFlexible, inspectAgentSession);

export default router;
