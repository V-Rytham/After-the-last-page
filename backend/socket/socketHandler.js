import { checkMeetAccess } from '../services/accessService.js';
import { getCanonicalBook } from '../services/canonicalBookService.js';
import { log } from '../utils/logger.js';
import { resolveSocketIdentity } from '../middleware/identityMiddleware.js';

export default function registerSocketEvents(io, sessionManager) {
  if (!sessionManager) {
    throw new Error('sessionManager is required');
  }
  let onlineCount = 0;

  const getSearchingCount = () => (
    Array.from(sessionManager.queue.values()).reduce((sum, queue) => sum + (queue?.length || 0), 0)
  );

  const emitStats = () => {
    io.emit('match_stats', {
      online: onlineCount,
      searching: getSearchingCount(),
      updatedAt: new Date().toISOString(),
    });
  };

  io.use((socket, next) => {
    const identity = resolveSocketIdentity(socket);
    socket.userId = identity.userId;
    socket.displayName = identity.displayName;
    next();
  });

  io.on('connection', (socket) => {
    log(`[SOCKET] User connected: ${socket.id}`);
    sessionManager.registerSocket({ userId: socket.userId, socketId: socket.id, displayName: socket.displayName });
    onlineCount += 1;
    emitStats();

    socket.emit('match_stats', {
      online: onlineCount,
      searching: getSearchingCount(),
      updatedAt: new Date().toISOString(),
    });

    socket.on('join_matchmaking', async ({ source, source_book_id: sourceBookId, prefType }) => {
      const normalizedSource = String(source || '').trim().toLowerCase();
      const normalizedSourceBookId = String(sourceBookId || '').trim();
      if (!normalizedSource || !normalizedSourceBookId) {
        socket.emit('access_denied', { message: 'source and source_book_id are required.' });
        return;
      }

      try {
        const access = await checkMeetAccess({ userId: socket.userId, source: normalizedSource, sourceBookId: normalizedSourceBookId });
        if (!access.access) {
          socket.emit('access_denied', { message: access?.message || 'Live reading rooms are only available for open-access books.' });
          return;
        }

        let roomId = '';
        try {
          const canonical = await getCanonicalBook({ source: normalizedSource, source_book_id: normalizedSourceBookId });
          roomId = String(canonical?.canonical_book_id || '').trim();
        } catch {
          roomId = `${normalizedSource}:${normalizedSourceBookId}`;
        }

        if (!roomId) {
          socket.emit('access_denied', { message: 'Unable to resolve book identity.' });
          return;
        }

        await sessionManager.joinMatchmaking({ userId: socket.userId, displayName: socket.displayName, bookId: roomId, prefType });
      } catch (error) {
        socket.emit('access_denied', { message: error.message || 'Unable to join matchmaking.' });
      } finally {
        emitStats();
      }
    });

    socket.on('leave_matchmaking', () => {
      sessionManager.leaveMatchmaking({ userId: socket.userId });
      emitStats();
    });

    socket.on('enter_conversation', ({ roomId }) => {
      sessionManager.enterConversation({ userId: socket.userId, roomId });
    });

    socket.on('leave_room', async ({ roomId, reason }) => {
      await sessionManager.leaveRoom({ userId: socket.userId, roomId, reason: reason || 'left' });
      emitStats();
    });

    socket.on('send_message', ({ roomId, message, senderId }) => {
      socket.to(roomId).emit('receive_message', { message, senderId, timestamp: new Date() });
    });

    socket.on('webrtc_offer', ({ roomId, offer }) => {
      socket.to(roomId).emit('webrtc_offer', { offer });
    });

    socket.on('webrtc_answer', ({ roomId, answer }) => {
      socket.to(roomId).emit('webrtc_answer', { answer });
    });

    socket.on('webrtc_ice_candidate', ({ roomId, candidate }) => {
      socket.to(roomId).emit('webrtc_ice_candidate', { candidate });
    });

    socket.on('disconnect', (reason) => {
      log(`[SOCKET] User disconnected: ${socket.id} (${reason || 'unknown'})`);
      onlineCount = Math.max(0, onlineCount - 1);
      sessionManager.unregisterSocket({ socketId: socket.id, reason: reason || 'disconnect' });
      emitStats();
    });
  });
}
