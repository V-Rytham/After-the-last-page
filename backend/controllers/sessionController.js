import { buildSafeErrorBody } from '../utils/runtime.js';
import { SESSION_STATES } from '../utils/sessionStates.js';

export const createSessionController = (sessionManager) => {
  if (!sessionManager) {
    throw new Error('sessionManager is required');
  }

  const startSession = async (req, res) => {
    try {
      const userId = req.user?._id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const { state, bookId, prefType, roomId } = req.body || {};
      const patch = {};
      if (bookId) patch.bookId = String(bookId);
      if (prefType) patch.prefType = String(prefType);
      if (roomId) patch.roomId = String(roomId);

      await sessionManager.ensureSession(userId, patch);
      if (state && Object.values(SESSION_STATES).includes(String(state))) {
        await sessionManager.setSessionState(userId, String(state), patch);
      }

      return res.json({ session: await sessionManager.getPublicSession(userId) });
    } catch (error) {
      return res.status(500).json(buildSafeErrorBody('Failed to start session.', error));
    }
  };

  const endSession = async (req, res) => {
    try {
      const userId = req.user?._id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      await sessionManager.endSession(userId, { reason: String(req.body?.reason || 'ended') });
      return res.json({ session: await sessionManager.getPublicSession(userId) });
    } catch (error) {
      return res.status(500).json(buildSafeErrorBody('Failed to end session.', error));
    }
  };

  const getStatus = async (req, res) => {
    try {
      const userId = req.user?._id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      return res.json({ session: await sessionManager.getPublicSession(userId) });
    } catch (error) {
      return res.status(500).json(buildSafeErrorBody('Failed to fetch session status.', error));
    }
  };

  return { startSession, endSession, getStatus };
};
