import express from 'express';
import {
  startAgentSession,
  sendAgentMessage,
  endAgentSession,
  inspectAgentSession,
} from '../controllers/agentController.js';
import { protectFlexible } from '../middleware/flexibleAuth.js';

const router = express.Router();

// Start a new agent session
router.post('/start', protectFlexible, startAgentSession);

// Send message to session
router.post('/message', protectFlexible, sendAgentMessage);

// End a session
router.post('/end', protectFlexible, endAgentSession);

// Inspect session metadata (for frontend synchronization)
router.get('/session/:sessionId', protectFlexible, inspectAgentSession);

export default router;
