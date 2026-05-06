import { buildSafeErrorBody } from '../utils/runtime.js';
import { checkMeetAccess } from '../services/accessService.js';
import { getCanonicalBook } from '../services/canonicalBookService.js';

const MATCH_PREF_TYPES = new Set(['text', 'voice', 'video']);
const MAX_BOOK_ID_LEN = 140;

const resolveIdentity = (req) => ({
  userId: String(req.identity?.userId || req.body?.userId || '').trim(),
  displayName: String(req.identity?.displayName || req.body?.displayName || '').trim() || 'Reader',
});

const buildCompositeRoomId = ({ source, sourceBookId }) => `${String(source || '').trim().toLowerCase()}:${String(sourceBookId || '').trim()}`;

export const createMatchmakingController = (sessionManager) => {
  if (!sessionManager) {
    throw new Error('sessionManager is required');
  }

  const join = async (req, res) => {
    try {
      const { userId, displayName } = resolveIdentity(req);
      const { source, source_book_id: sourceBookId, prefType } = req.body || {};

      if (!userId) {
        return res.status(400).json({ message: 'userId is required.' });
      }

      const normalizedSource = String(source || '').trim().toLowerCase();
      const normalizedSourceBookId = String(sourceBookId || '').trim();
      if (!normalizedSource || !normalizedSourceBookId || normalizedSourceBookId.length > MAX_BOOK_ID_LEN) {
        return res.status(400).json({ message: 'source and source_book_id are required.' });
      }

      const normalizedPrefType = String(prefType || 'text').trim().toLowerCase();
      if (!MATCH_PREF_TYPES.has(normalizedPrefType)) {
        return res.status(400).json({ message: 'Invalid prefType. Use text, voice, or video.' });
      }

      const access = await checkMeetAccess({ userId, source: normalizedSource, sourceBookId: normalizedSourceBookId });
      if (!access?.access) {
        return res.status(403).json({ message: access?.message || 'Live reading rooms are only available for open-access books.' });
      }

      let canonicalBook = null;
      let canonicalBookId = '';
      try {
        canonicalBook = await getCanonicalBook({ source: normalizedSource, source_book_id: normalizedSourceBookId });
        canonicalBookId = String(canonicalBook?.canonical_book_id || '').trim();
      } catch {
        // Fail open: Meet can still work with a deterministic composite room id even if
        // canonical metadata services (db/external fetch) are temporarily unavailable.
        canonicalBook = null;
        canonicalBookId = buildCompositeRoomId({ source: normalizedSource, sourceBookId: normalizedSourceBookId });
      }

      if (!canonicalBookId) {
        return res.status(422).json({ message: 'Unable to resolve canonical book identity.' });
      }

      const result = await sessionManager.joinMatchmaking({
        userId,
        displayName,
        bookId: canonicalBookId,
        prefType: normalizedPrefType,
      });

      return res.json({
        ...result,
        room_id: canonicalBookId,
        canonical_book_id: canonicalBookId,
        book: {
          canonical_book_id: canonicalBookId,
          title: canonicalBook?.title || 'Untitled',
          author: canonicalBook?.author || '',
          source: normalizedSource,
          source_book_id: normalizedSourceBookId,
        },
        session: sessionManager.getPublicSession(userId),
      });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status === 409 && error?.message) {
        return res.status(409).json({ message: error.message });
      }
      return res.status(status).json(buildSafeErrorBody('Failed to join matchmaking.', error));
    }
  };

  const leave = async (req, res) => {
    try {
      const { userId } = resolveIdentity(req);
      if (!userId) {
        return res.status(400).json({ message: 'userId is required.' });
      }

      sessionManager.leaveMatchmaking({ userId });
      return res.json({ session: sessionManager.getPublicSession(userId) });
    } catch (error) {
      return res.status(500).json(buildSafeErrorBody('Failed to leave matchmaking.', error));
    }
  };

  return { join, leave };
};
