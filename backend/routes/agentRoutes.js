import express from 'express';
import { endAgentSession, sendAgentMessage, startAgentSession } from '../controllers/agentController.js';
import { protectFlexible } from '../middleware/flexibleAuth.js';

const router = express.Router();

router.post('/start', protectFlexible, startAgentSession);
router.post('/message', protectFlexible, sendAgentMessage);
router.post('/end', protectFlexible, endAgentSession);

export default router;
