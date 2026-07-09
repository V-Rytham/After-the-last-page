import { SESSION_STATES } from '../utils/sessionStates.js';
import { keys, userChannel } from './realtime/keys.js';
import { MatchmakingQueue } from './realtime/matchmakingQueue.js';
import { SessionStore } from './realtime/sessionStore.js';

const normalizeId = (value) => String(value || '').trim();
const MATCH_PREF_TYPES = new Set(['text', 'voice', 'video']);
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

// A dropped transport, a page refresh, or a websocket upgrade all surface as a
// disconnect. Tearing the room down immediately would end a conversation over a
// momentary blip, so give the reader a window to come back on any instance.
const RECONNECT_GRACE_MS = 10_000;

const badRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

/**
 * Coordinates presence, matchmaking and rooms across every backend instance.
 *
 * All shared state lives in Redis, and every socket lookup goes through the
 * Socket.IO adapter rather than `io.sockets.sockets` (which only ever sees the
 * sockets attached to the current process).
 */
export class RealtimeSessionManager {
  constructor(io, redis) {
    if (!io) throw new Error('io is required');
    if (!redis) throw new Error('redis is required');

    this.io = io;
    this.redis = redis;
    this.sessions = new SessionStore(redis);
    this.queue = new MatchmakingQueue(redis);
  }

  /** True when the user has at least one live socket on ANY instance. */
  async isOnline(userId) {
    const sockets = await this.io.in(userChannel(normalizeId(userId))).fetchSockets();
    return sockets.length > 0;
  }

  /** Cluster-wide connected socket count. */
  async onlineCount() {
    const sockets = await this.io.of('/').adapter.sockets(new Set());
    return sockets.size;
  }

  searchingCount() {
    return this.queue.searchingCount();
  }

  emitToUser(userId, event, payload) {
    this.io.to(userChannel(normalizeId(userId))).emit(event, payload);
  }

  async getSession(userId) {
    const session = await this.sessions.get(userId);
    return session || { userId: normalizeId(userId), state: SESSION_STATES.IDLE };
  }

  async getPublicSession(userId) {
    const { partnerUserId, ...rest } = await this.getSession(userId);
    void partnerUserId;
    return rest;
  }

  ensureSession(userId, patch = {}) {
    return this.sessions.upsert(userId, patch);
  }

  setSessionState(userId, state, extra = {}) {
    return this.sessions.setState(userId, state, extra);
  }

  /**
   * Registration is implicit: the socket joins a room named for its user, which
   * the adapter replicates cluster-wide. That single primitive replaces the old
   * userSockets/socketToUser/_getPrimarySocketId bookkeeping and, because
   * Socket.IO removes a socket from its rooms on disconnect, it cannot leak.
   */
  async registerSocket(socket) {
    await socket.join(userChannel(socket.userId));

    // A reconnecting reader arrives on a brand-new socket that belongs to none
    // of the previous socket's rooms. Without this, the session survives the
    // blip but every relay silently stops reaching them.
    const roomId = await this.redis.get(keys.userRoom(socket.userId));
    if (roomId && (await this.isRoomMember(socket.userId, roomId))) {
      await socket.join(roomId);
    }
  }

  async unregisterSocket(socket, reason = 'disconnect') {
    // Socket.IO removes the socket from its rooms before this handler runs, so a
    // zero count means every tab of this reader is gone -- for now.
    const userId = socket.userId;
    if (await this.isOnline(userId)) return;

    // A reader waiting in the queue must leave it at once: leaving a ghost there
    // would pair a live reader with someone who is no longer connected.
    const { state } = await this.getSession(userId);
    if (state !== SESSION_STATES.MATCHED && state !== SESSION_STATES.IN_CONVERSATION) {
      await this.endSession(userId, { reason });
      return;
    }

    // A matched reader keeps their room for a short window so a transport blip
    // does not end the conversation.
    const timer = setTimeout(() => {
      void (async () => {
        if (await this.isOnline(userId)) return; // came back
        await this.endSession(userId, { reason });
      })().catch(() => {});
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
  }

  async joinMatchmaking({ userId, displayName = 'Reader', bookId, prefType }) {
    const normalizedUserId = normalizeId(userId);
    const normalizedBookId = normalizeId(bookId);
    const normalizedPrefType = normalizeId(prefType).toLowerCase() || 'text';

    if (!normalizedUserId || !normalizedBookId) throw badRequest('userId and bookId are required');
    if (!MATCH_PREF_TYPES.has(normalizedPrefType)) {
      throw badRequest('Invalid prefType. Supported values are text, voice, or video.');
    }

    if (!(await this.isOnline(normalizedUserId))) {
      const error = new Error('No active socket connection.');
      error.statusCode = 409;
      throw error;
    }

    // Tear down any prior room/queue entry so we always transition from IDLE.
    await this.#forceIdle(normalizedUserId, 're-queue');
    await this.sessions.setState(normalizedUserId, SESSION_STATES.SEARCHING, {
      bookId: normalizedBookId,
      prefType: normalizedPrefType,
      roomId: null,
      partnerUserId: null,
    });
    await this.redis.set(keys.userQueue(normalizedUserId), MatchmakingQueue.queueKeyFor(normalizedBookId, normalizedPrefType), 'PX', ROOM_TTL_MS);

    const pair = await this.queue.enqueueAndPair({
      userId: normalizedUserId,
      displayName: String(displayName || 'Reader').trim() || 'Reader',
      bookId: normalizedBookId,
      prefType: normalizedPrefType,
    });

    if (!pair) return { matched: false };

    const finalized = await this.#finalizeMatch(pair);
    return finalized ? { matched: true, roomId: finalized.roomId } : { matched: false };
  }

  /**
   * A queued reader may have disconnected between enqueue and pairing. Drop the
   * dead one, put the survivor back at the head of the queue, and tell them.
   */
  async #finalizeMatch({ roomId, a, b }) {
    const [aOnline, bOnline] = await Promise.all([this.isOnline(a.userId), this.isOnline(b.userId)]);

    if (!aOnline || !bOnline) {
      const dead = aOnline ? b : a;
      const survivor = aOnline ? a : (bOnline ? b : null);

      await this.#resetToIdle(dead.userId);

      if (survivor) {
        await this.queue.requeueFront(survivor);
        await this.sessions.setState(survivor.userId, SESSION_STATES.SEARCHING, { roomId: null, partnerUserId: null });
        this.emitToUser(survivor.userId, 'match_requeued', {
          message: 'The other reader disconnected before the chat opened. We are finding a new match.',
        });
      }
      return null;
    }

    await Promise.all([
      this.io.in(userChannel(a.userId)).socketsJoin(roomId),
      this.io.in(userChannel(b.userId)).socketsJoin(roomId),
    ]);

    await this.redis
      .multi()
      .sadd(keys.room(roomId), a.userId, b.userId)
      .pexpire(keys.room(roomId), ROOM_TTL_MS)
      .set(keys.userRoom(a.userId), roomId, 'PX', ROOM_TTL_MS)
      .set(keys.userRoom(b.userId), roomId, 'PX', ROOM_TTL_MS)
      .del(keys.userQueue(a.userId), keys.userQueue(b.userId))
      .exec();

    await Promise.all([
      this.sessions.setState(a.userId, SESSION_STATES.MATCHED, { roomId, partnerUserId: b.userId }),
      this.sessions.setState(b.userId, SESSION_STATES.MATCHED, { roomId, partnerUserId: a.userId }),
    ]);

    this.emitToUser(a.userId, 'match_found', {
      roomId, role: 'initiator', message: 'You have been paired with a reader.', partnerUsername: b.displayName || null,
    });
    this.emitToUser(b.userId, 'match_found', {
      roomId, role: 'responder', message: 'You have been paired with a reader.', partnerUsername: a.displayName || null,
    });

    return { roomId };
  }

  async leaveMatchmaking({ userId }) {
    const normalizedUserId = normalizeId(userId);
    if (!normalizedUserId) return { removed: false };

    const queueKey = await this.redis.get(keys.userQueue(normalizedUserId));
    let removed = 0;
    if (queueKey) {
      const [bookId, prefType] = [queueKey.slice(0, queueKey.lastIndexOf('_')), queueKey.slice(queueKey.lastIndexOf('_') + 1)];
      removed = await this.queue.remove({ userId: normalizedUserId, bookId, prefType });
      await this.redis.del(keys.userQueue(normalizedUserId));
    } else {
      await this.queue.dropFromSearching(normalizedUserId);
    }

    const session = await this.sessions.get(normalizedUserId);
    if (session?.state === SESSION_STATES.SEARCHING) {
      await this.sessions.setState(normalizedUserId, SESSION_STATES.IDLE, { prefType: null, bookId: null });
    }
    return { removed: removed > 0 };
  }

  async isRoomMember(userId, roomId) {
    const normalizedRoomId = normalizeId(roomId);
    if (!normalizedRoomId) return false;
    return (await this.redis.sismember(keys.room(normalizedRoomId), normalizeId(userId))) === 1;
  }

  async enterConversation({ userId, roomId }) {
    const normalizedUserId = normalizeId(userId);
    const normalizedRoomId = normalizeId(roomId) || (await this.redis.get(keys.userRoom(normalizedUserId)));
    if (!normalizedUserId || !normalizedRoomId) return null;

    // Ignore duplicate, out-of-order or spoofed events rather than throwing an
    // illegal-transition error: room ids are guessable, so membership is the gate.
    if (!(await this.isRoomMember(normalizedUserId, normalizedRoomId))) return null;

    const session = await this.sessions.get(normalizedUserId);
    if (session?.state === SESSION_STATES.IN_CONVERSATION) return session;
    if (session?.state !== SESSION_STATES.MATCHED) return null;

    return this.sessions.setState(normalizedUserId, SESSION_STATES.IN_CONVERSATION, { roomId: normalizedRoomId });
  }

  async leaveRoom({ userId, roomId, reason = 'left' }) {
    const normalizedUserId = normalizeId(userId);
    const normalizedRoomId = normalizeId(roomId) || (await this.redis.get(keys.userRoom(normalizedUserId)));
    if (!normalizedUserId || !normalizedRoomId) return { left: false };

    const members = await this.redis.smembers(keys.room(normalizedRoomId));
    if (members.length === 0) {
      await this.#resetToIdle(normalizedUserId);
      return { left: false };
    }

    const partnerUserId = members.find((member) => member !== normalizedUserId) || null;

    await this.#resetToIdle(normalizedUserId);
    this.io.in(userChannel(normalizedUserId)).socketsLeave(normalizedRoomId);

    if (partnerUserId) {
      await this.#resetToIdle(partnerUserId);
      this.emitToUser(partnerUserId, 'partner_left', {
        roomId: normalizedRoomId,
        reason,
        message: 'The other reader has left the discussion',
      });
      this.io.in(userChannel(partnerUserId)).socketsLeave(normalizedRoomId);
    }

    await this.redis.del(keys.room(normalizedRoomId));
    return { left: true };
  }

  async #resetToIdle(userId) {
    await this.redis.del(keys.userRoom(userId));
    await this.queue.dropFromSearching(userId);
    await this.sessions.setState(userId, SESSION_STATES.IDLE, {
      roomId: null, partnerUserId: null, prefType: null, bookId: null,
    });
  }

  async #forceIdle(userId, reason = 'reset') {
    await this.leaveMatchmaking({ userId });
    const roomId = await this.redis.get(keys.userRoom(userId));
    if (roomId) await this.leaveRoom({ userId, roomId, reason });
    await this.#resetToIdle(userId);
  }

  async endSession(userId, { reason = 'ended' } = {}) {
    const normalizedUserId = normalizeId(userId);
    if (!normalizedUserId) return { ended: false };
    await this.#forceIdle(normalizedUserId, reason);
    return { ended: true };
  }
}
