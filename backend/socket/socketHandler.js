import { checkMeetAccess } from '../services/accessService.js';
import { getCanonicalBook } from '../services/canonicalBookService.js';
import { log } from '../utils/logger.js';
import { requireSocketAuth } from '../middleware/identityMiddleware.js';

const STATS_INTERVAL_MS = 1_000;

// Relayed events share one shape: verify the sender really is in the room, then
// forward to the other member. Room ids are canonical-book derived and therefore
// guessable, so without this check any authenticated socket could inject chat or
// WebRTC frames into a room it was never matched into.
const RELAYED_EVENTS = ['send_message', 'webrtc_offer', 'webrtc_answer', 'webrtc_ice_candidate'];

// Socket.IO does not await listeners, so a rejected async handler escapes as an
// unhandledRejection -- which this process treats as fatal. Contain it per event.
const safe = (socket, event, handler) => {
  socket.on(event, (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      log(`[SOCKET] handler '${event}' failed`, { socketId: socket.id, error: error?.message || error });
    });
  });
};

export default function registerSocketEvents(io, sessionManager) {
  if (!sessionManager) throw new Error('sessionManager is required');

  // Stats are derived from cluster-wide state, so every instance would otherwise
  // recompute and rebroadcast them on every connect, disconnect and join. Coalesce
  // into at most one broadcast per interval per instance.
  let statsPending = false;
  const emitStats = () => {
    if (statsPending) return;
    statsPending = true;
    setTimeout(async () => {
      statsPending = false;
      try {
        const [online, searching] = await Promise.all([
          sessionManager.onlineCount(),
          sessionManager.searchingCount(),
        ]);
        io.emit('match_stats', { online, searching, updatedAt: new Date().toISOString() });
      } catch (error) {
        log('[SOCKET] failed to broadcast stats', { error: error?.message || error });
      }
    }, STATS_INTERVAL_MS).unref?.();
  };

  io.use(requireSocketAuth);

  io.on('connection', (socket) => {
    log(`[SOCKET] connected ${socket.id} user=${socket.userId}`);
    sessionManager.registerSocket(socket)
      .then(emitStats)
      .catch((error) => log('[SOCKET] registration failed', { socketId: socket.id, error: error?.message || error }));

    safe(socket, 'join_matchmaking', async ({ source, source_book_id: sourceBookId, prefType }) => {
      const normalizedSource = String(source || '').trim().toLowerCase();
      const normalizedSourceBookId = String(sourceBookId || '').trim();
      if (!normalizedSource || !normalizedSourceBookId) {
        socket.emit('access_denied', { message: 'source and source_book_id are required.' });
        return;
      }

      try {
        const access = await checkMeetAccess({
          userId: socket.userId,
          source: normalizedSource,
          sourceBookId: normalizedSourceBookId,
        });
        if (!access.access) {
          socket.emit('access_denied', { message: access?.message || 'Select a valid book to start a Meet chat.' });
          return;
        }

        let roomId;
        try {
          const canonical = await getCanonicalBook({ source: normalizedSource, source_book_id: normalizedSourceBookId });
          roomId = String(canonical?.canonical_book_id || '').trim();
        } catch {
          // Fail open: a deterministic composite id keeps Meet usable when the
          // canonical metadata lookup is unavailable.
          roomId = `${normalizedSource}:${normalizedSourceBookId}`;
        }

        if (!roomId) {
          socket.emit('access_denied', { message: 'Unable to resolve book identity.' });
          return;
        }

        await sessionManager.joinMatchmaking({
          userId: socket.userId,
          displayName: socket.displayName,
          bookId: roomId,
          prefType,
        });
      } catch (error) {
        socket.emit('access_denied', { message: error.message || 'Unable to join matchmaking.' });
      } finally {
        emitStats();
      }
    });

    safe(socket, 'leave_matchmaking', async () => {
      await sessionManager.leaveMatchmaking({ userId: socket.userId });
      emitStats();
    });

    safe(socket, 'enter_conversation', async ({ roomId }) => {
      await sessionManager.enterConversation({ userId: socket.userId, roomId });
    });

    safe(socket, 'leave_room', async ({ roomId, reason }) => {
      await sessionManager.leaveRoom({ userId: socket.userId, roomId, reason: reason || 'left' });
      emitStats();
    });

    for (const event of RELAYED_EVENTS) {
      safe(socket, event, async (payload = {}) => {
        const { roomId, ...rest } = payload;
        if (!(await sessionManager.isRoomMember(socket.userId, roomId))) return;

        // senderId is taken from the authenticated socket, never from the payload,
        // so a client cannot attribute a message to another reader.
        if (event === 'send_message') {
          socket.to(roomId).emit('receive_message', {
            message: rest.message,
            senderId: socket.userId,
            timestamp: new Date(),
          });
          return;
        }
        socket.to(roomId).emit(event, rest);
      });
    }

    safe(socket, 'disconnect', async (reason) => {
      log(`[SOCKET] disconnected ${socket.id} (${reason})`);
      await sessionManager.unregisterSocket(socket, reason);
      emitStats();
    });
  });
}
