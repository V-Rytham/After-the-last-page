import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSessionManager } from '../services/realtimeSessionManager.js';
import { SESSION_STATES } from '../utils/sessionStates.js';

// ---------------------------------------------------------------------------
// Test doubles + helpers
// ---------------------------------------------------------------------------

const createFakeIo = () => ({ sockets: { sockets: new Map() } });

const createFakeSocket = (socketId) => {
  const emitted = [];
  const rooms = new Set();
  return {
    id: socketId,
    emitted,
    rooms,
    join: (roomId) => rooms.add(roomId),
    leave: (roomId) => rooms.delete(roomId),
    emit: (event, payload) => emitted.push({ event, payload }),
  };
};

// Register a user with a live socket the way the socket handler does.
const spawn = (manager, io, userId, socketId = `s-${userId}`) => {
  const socket = createFakeSocket(socketId);
  io.sockets.sockets.set(socketId, socket);
  manager.registerSocket({ userId, socketId });
  return socket;
};

// Simulate a hard socket disconnect (transport gone + handler cleanup).
const disconnect = (manager, io, socketId) => {
  manager.unregisterSocket({ socketId });
  io.sockets.sockets.delete(socketId);
};

const countEvent = (socket, event) => socket.emitted.filter((entry) => entry.event === event).length;
const totalQueued = (manager) => Array.from(manager.queue.values()).reduce((sum, q) => sum + (q?.length || 0), 0);

// Assert none of the bookkeeping maps retain state for anyone (no leaks).
const assertNoResidualState = (manager) => {
  assert.equal(totalQueued(manager), 0, 'queue should be drained');
  assert.equal(manager.userToQueueKey.size, 0, 'userToQueueKey should be empty');
  assert.equal(manager.roomMembers.size, 0, 'roomMembers should be empty');
  assert.equal(manager.userToRoomId.size, 0, 'userToRoomId should be empty');
  // Empty queue keys must not linger as empty arrays.
  for (const [key, items] of manager.queue.entries()) {
    assert.ok(items.length > 0, `queue key ${key} should not be an empty array`);
  }
};

// ---------------------------------------------------------------------------
// 1. Two users, same book, same mode -> matched exactly once
// ---------------------------------------------------------------------------

test('same book + mode: two users match exactly once', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  const a = spawn(manager, io, 'u-a');
  const b = spawn(manager, io, 'u-b');

  const r1 = await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  const r2 = await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });

  assert.equal(r1.matched, false);
  assert.equal(r2.matched, true);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.MATCHED);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.MATCHED);
  assert.equal(manager.getSession('u-a').roomId, manager.getSession('u-b').roomId);

  // Exactly one match_found per user — never double-matched.
  assert.equal(countEvent(a, 'match_found'), 1);
  assert.equal(countEvent(b, 'match_found'), 1);
  assert.equal(totalQueued(manager), 0);
  assert.equal(manager.roomMembers.size, 1);
});

// ---------------------------------------------------------------------------
// 2. Different books -> never matched
// ---------------------------------------------------------------------------

test('different books never match', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  const a = spawn(manager, io, 'u-a');
  const b = spawn(manager, io, 'u-b');

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  const r = await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-2', prefType: 'text' });

  assert.equal(r.matched, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.SEARCHING);
  assert.equal(countEvent(a, 'match_found'), 0);
  assert.equal(countEvent(b, 'match_found'), 0);
  assert.equal(manager.roomMembers.size, 0);
});

// ---------------------------------------------------------------------------
// 3. Mode isolation: text / voice / video queues never cross
// ---------------------------------------------------------------------------

test('mode queues are isolated (text/voice/video never cross-match)', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-text');
  spawn(manager, io, 'u-voice');
  spawn(manager, io, 'u-video');

  await manager.joinMatchmaking({ userId: 'u-text', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-voice', bookId: 'book-1', prefType: 'voice' });
  const v = await manager.joinMatchmaking({ userId: 'u-video', bookId: 'book-1', prefType: 'video' });

  assert.equal(v.matched, false);
  assert.equal(manager.getSession('u-text').state, SESSION_STATES.SEARCHING);
  assert.equal(manager.getSession('u-voice').state, SESSION_STATES.SEARCHING);
  assert.equal(manager.getSession('u-video').state, SESSION_STATES.SEARCHING);
  assert.equal(manager.roomMembers.size, 0);

  // But two users on the SAME book+mode do match.
  spawn(manager, io, 'u-voice2');
  const matched = await manager.joinMatchmaking({ userId: 'u-voice2', bookId: 'book-1', prefType: 'voice' });
  assert.equal(matched.matched, true);
  assert.equal(manager.getSession('u-voice').state, SESSION_STATES.MATCHED);
  assert.equal(manager.getSession('u-voice2').state, SESSION_STATES.MATCHED);
  // text + video users are untouched.
  assert.equal(manager.getSession('u-text').state, SESSION_STATES.SEARCHING);
  assert.equal(manager.getSession('u-video').state, SESSION_STATES.SEARCHING);
});

// ---------------------------------------------------------------------------
// 4. A user cannot join twice simultaneously (no duplicate queue entry)
// ---------------------------------------------------------------------------

test('duplicate/simultaneous join does not create two queue entries', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a');

  // Fire two joins "at once" — serialized by the matchmaking lock.
  const [r1, r2] = await Promise.all([
    manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' }),
    manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' }),
  ]);

  assert.equal(r1.matched, false);
  assert.equal(r2.matched, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);
  assert.equal(totalQueued(manager), 1, 'exactly one queue entry for the user');

  // A real partner still matches the single entry (not a phantom duplicate).
  spawn(manager, io, 'u-b');
  const r3 = await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  assert.equal(r3.matched, true);
  assert.equal(totalQueued(manager), 0);
});

// ---------------------------------------------------------------------------
// 5. A user cannot belong to two sessions at once
// ---------------------------------------------------------------------------

test('re-joining abandons the old room; user is never in two rooms', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  const a = spawn(manager, io, 'u-a');
  const b = spawn(manager, io, 'u-b');

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const room1 = manager.getSession('u-a').roomId;
  manager.enterConversation({ userId: 'u-a', roomId: room1 });

  // u-a starts a brand-new search while still in the conversation.
  const rejoin = await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-9', prefType: 'text' });
  assert.equal(rejoin.matched, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);
  // Old room is torn down; partner notified and reset.
  assert.equal(manager.roomMembers.has(room1), false);
  assert.equal(manager.userToRoomId.has('u-a'), false);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.IDLE);
  assert.equal(countEvent(b, 'partner_left'), 1);
  void a;
});

// ---------------------------------------------------------------------------
// 6. Browser refresh during SEARCHING
// ---------------------------------------------------------------------------

test('refresh during SEARCHING: clean disconnect clears the queue, rejoin works', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-old');

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.equal(totalQueued(manager), 1);

  // Refresh: old socket goes away, new one comes up.
  disconnect(manager, io, 's-old');
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assert.equal(totalQueued(manager), 0, 'no orphaned queue entry after refresh');

  spawn(manager, io, 'u-a', 's-new');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.equal(totalQueued(manager), 1, 'exactly one entry after rejoin');
  assert.equal(manager.queue.get('book-1_text')[0].socketId, 's-new');
});

test('refresh during SEARCHING with overlapping sockets: sweep reconciles the stale entry', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-old');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  // New tab connects BEFORE the old socket's disconnect fires.
  spawn(manager, io, 'u-a', 's-new');
  disconnect(manager, io, 's-old'); // user still has s-new, so session is preserved
  // The queue still references the dead s-old socket until reconciled.
  const removed = manager.sweepQueues();
  assert.equal(removed, 1, 'stale queue entry pruned by sweep');
  assert.equal(totalQueued(manager), 0);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
});

// ---------------------------------------------------------------------------
// 7. Browser refresh during IN_CONVERSATION
// ---------------------------------------------------------------------------

test('refresh during IN_CONVERSATION: partner is notified and room torn down', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  const b = spawn(manager, io, 'u-b', 's-b');

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const room = manager.getSession('u-a').roomId;
  manager.enterConversation({ userId: 'u-a', roomId: room });
  manager.enterConversation({ userId: 'u-b', roomId: room });

  // u-a refreshes: last socket drops.
  disconnect(manager, io, 's-a');

  assert.equal(countEvent(b, 'partner_left'), 1);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.IDLE);
  assert.equal(manager.roomMembers.has(room), false);
  assert.equal(manager.userToRoomId.size, 0);

  // u-a comes back and can start a fresh search.
  spawn(manager, io, 'u-a', 's-a2');
  const r = await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.equal(r.matched, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);
});

// ---------------------------------------------------------------------------
// 8/9. Disconnect while searching / in conversation
// ---------------------------------------------------------------------------

test('disconnect while searching removes the queue entry and resets state', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  disconnect(manager, io, 's-a');
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assertNoResidualState(manager);
});

test('disconnect while in conversation cleans the room and notifies partner', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  const b = spawn(manager, io, 'u-b', 's-b');

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const room = manager.getSession('u-a').roomId;
  manager.enterConversation({ userId: 'u-a', roomId: room });
  manager.enterConversation({ userId: 'u-b', roomId: room });

  disconnect(manager, io, 's-a');
  assert.equal(countEvent(b, 'partner_left'), 1);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.IDLE);
  // u-b is still connected; its socket bookkeeping remains but no room/queue leaks.
  assert.equal(manager.roomMembers.size, 0);
  assert.equal(manager.userToRoomId.size, 0);
  assert.equal(totalQueued(manager), 0);
});

// ---------------------------------------------------------------------------
// 10. Server restart while users are queued
// ---------------------------------------------------------------------------

test('server restart: a fresh manager has no residual sessions or queues', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  // "Restart" = a new manager instance with fresh in-memory state.
  const restarted = new RealtimeSessionManager(createFakeIo());
  assert.equal(restarted.getSession('u-a').state, SESSION_STATES.IDLE);
  assert.equal(totalQueued(restarted), 0);
  assert.equal(restarted.roomMembers.size, 0);
});

// ---------------------------------------------------------------------------
// 11. Duplicate HTTP requests (idempotency of leave/end)
// ---------------------------------------------------------------------------

test('duplicate leave/end requests are idempotent and never throw', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  manager.leaveMatchmaking({ userId: 'u-a' });
  manager.leaveMatchmaking({ userId: 'u-a' }); // second call: no-op
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);

  await manager.endSession('u-a');
  await manager.endSession('u-a'); // idempotent
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assertNoResidualState(manager);
});

// ---------------------------------------------------------------------------
// 12. Duplicate WebSocket events (idempotent enter/leave)
// ---------------------------------------------------------------------------

test('duplicate enter_conversation / leave_room events are idempotent', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  spawn(manager, io, 'u-b', 's-b');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const room = manager.getSession('u-a').roomId;

  manager.enterConversation({ userId: 'u-a', roomId: room });
  manager.enterConversation({ userId: 'u-a', roomId: room }); // duplicate
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IN_CONVERSATION);

  await manager.leaveRoom({ userId: 'u-a', roomId: room, reason: 'leave' });
  const second = await manager.leaveRoom({ userId: 'u-a', roomId: room, reason: 'leave' }); // duplicate
  assert.equal(second.left, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
});

// ---------------------------------------------------------------------------
// 13. Out-of-order WebSocket events
// ---------------------------------------------------------------------------

test('out-of-order events do not throw or cause illegal transitions', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');

  // enter_conversation before any match: not a room member -> ignored, no throw.
  assert.doesNotThrow(() => manager.enterConversation({ userId: 'u-a', roomId: 'ghost-room' }));
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);

  // leave_room before any match: no-op.
  const left = await manager.leaveRoom({ userId: 'u-a', roomId: 'ghost-room' });
  assert.equal(left.left, false);

  // enter_conversation while merely SEARCHING (arrives before match_found): ignored.
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.doesNotThrow(() => manager.enterConversation({ userId: 'u-a', roomId: 'book-1' }));
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);

  // Relay for a non-member is rejected.
  assert.equal(manager.isRoomMember('u-a', 'book-1'), false);
});

// ---------------------------------------------------------------------------
// 14. Multiple browser tabs using the same account
// ---------------------------------------------------------------------------

test('multiple tabs: closing one tab keeps the session; closing the last ends it', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-tab1');
  spawn(manager, io, 'u-a', 's-tab2'); // second tab, same account
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  // Close tab 1 — user still has tab 2, session must survive.
  disconnect(manager, io, 's-tab1');
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);

  // Close tab 2 (last socket) — session ends.
  disconnect(manager, io, 's-tab2');
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assertNoResidualState(manager);
});

test('multiple tabs never self-match', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-tab1');
  spawn(manager, io, 'u-a', 's-tab2');

  // Both tabs try to join the same book+mode.
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  const r = await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.equal(r.matched, false, 'a user must never be matched with themselves');
  assert.equal(totalQueued(manager), 1);
  assert.equal(manager.roomMembers.size, 0);
});

// ---------------------------------------------------------------------------
// 15. Simultaneous matchmaking from many users
// ---------------------------------------------------------------------------

test('many simultaneous joiners on one book+mode pair up with no double-assignment', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  const N = 50;
  const users = Array.from({ length: N }, (_, i) => `u-${i}`);
  const sockets = users.map((u) => spawn(manager, io, u));

  await Promise.all(users.map((u) => manager.joinMatchmaking({ userId: u, bookId: 'book-1', prefType: 'text' })));

  const matched = users.filter((u) => manager.getSession(u).state === SESSION_STATES.MATCHED);
  assert.equal(matched.length, N, 'all even users matched');

  // Every matched user is in exactly one room, each room has exactly 2 members,
  // and no user appears in two rooms.
  const roomIds = new Set();
  const seenUsers = new Set();
  for (const [roomId, members] of manager.roomMembers.entries()) {
    roomIds.add(roomId);
    assert.equal(members.size, 2, `room ${roomId} must have exactly 2 members`);
    for (const u of members) {
      assert.equal(seenUsers.has(u), false, `${u} must not be in two rooms`);
      seenUsers.add(u);
    }
  }
  assert.equal(roomIds.size, N / 2, 'exactly N/2 rooms');
  assert.equal(seenUsers.size, N);
  assert.equal(totalQueued(manager), 0, 'queue fully drained');
  // Each socket got exactly one match_found.
  assert.ok(sockets.every((s) => countEvent(s, 'match_found') === 1));
});

test('odd number of simultaneous joiners leaves exactly one searcher', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  const N = 51;
  const users = Array.from({ length: N }, (_, i) => `u-${i}`);
  users.forEach((u) => spawn(manager, io, u));

  await Promise.all(users.map((u) => manager.joinMatchmaking({ userId: u, bookId: 'book-1', prefType: 'text' })));

  const matched = users.filter((u) => manager.getSession(u).state === SESSION_STATES.MATCHED);
  const searching = users.filter((u) => manager.getSession(u).state === SESSION_STATES.SEARCHING);
  assert.equal(matched.length, N - 1);
  assert.equal(searching.length, 1);
  assert.equal(totalQueued(manager), 1);
});

// ---------------------------------------------------------------------------
// 16/17. Cleanup after conversation ends / after unexpected disconnect
// ---------------------------------------------------------------------------

test('cleanup after a conversation ends leaves no residual state', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  spawn(manager, io, 'u-b', 's-b');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const room = manager.getSession('u-a').roomId;
  manager.enterConversation({ userId: 'u-a', roomId: room });
  manager.enterConversation({ userId: 'u-b', roomId: room });

  await manager.leaveRoom({ userId: 'u-a', roomId: room, reason: 'done' });

  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.IDLE);
  assertNoResidualState(manager);
});

test('cleanup after both users disconnect leaves no residual state at all', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  spawn(manager, io, 'u-b', 's-b');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  manager.enterConversation({ userId: 'u-a', roomId: manager.getSession('u-a').roomId });

  disconnect(manager, io, 's-a');
  disconnect(manager, io, 's-b');

  assertNoResidualState(manager);
  assert.equal(manager.userSockets.size, 0, 'userSockets fully cleared');
  assert.equal(manager.socketToUser.size, 0, 'socketToUser fully cleared');
});

// ---------------------------------------------------------------------------
// 18. No memory leaks across a churn of operations
// ---------------------------------------------------------------------------

test('no leaks after a churn of joins, matches, leaves and disconnects', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);

  for (let round = 0; round < 25; round += 1) {
    const a = `a-${round}`;
    const b = `b-${round}`;
    spawn(manager, io, a, `sa-${round}`);
    spawn(manager, io, b, `sb-${round}`);
    await manager.joinMatchmaking({ userId: a, bookId: `book-${round % 3}`, prefType: 'text' });
    await manager.joinMatchmaking({ userId: b, bookId: `book-${round % 3}`, prefType: 'text' });

    if (round % 2 === 0) {
      // Graceful leave.
      await manager.leaveRoom({ userId: a, roomId: manager.getSession(a).roomId, reason: 'done' });
      disconnect(manager, io, `sa-${round}`);
      disconnect(manager, io, `sb-${round}`);
    } else {
      // Abrupt disconnect.
      disconnect(manager, io, `sa-${round}`);
      disconnect(manager, io, `sb-${round}`);
    }
  }

  manager.sweepQueues();
  assertNoResidualState(manager);
  assert.equal(manager.userSockets.size, 0);
  assert.equal(manager.socketToUser.size, 0);
});

// ---------------------------------------------------------------------------
// sweepQueues: dead entries are pruned and empty keys removed
// ---------------------------------------------------------------------------

test('sweepQueues prunes dead sockets, deletes empty keys, resets orphaned sessions', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);
  spawn(manager, io, 'u-a', 's-a');
  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  // Socket vanishes WITHOUT a disconnect event firing (worst case).
  io.sockets.sockets.delete('s-a');
  const removed = manager.sweepQueues();

  assert.equal(removed, 1);
  assert.equal(totalQueued(manager), 0);
  assert.equal(manager.queue.has('book-1_text'), false, 'empty queue key deleted');
  assert.equal(manager.userToQueueKey.has('u-a'), false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
});
