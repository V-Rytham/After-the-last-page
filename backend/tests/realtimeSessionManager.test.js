import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSessionManager } from '../services/realtimeSessionManager.js';
import { SESSION_STATES } from '../utils/sessionStates.js';

const createFakeIo = () => ({
  sockets: {
    sockets: new Map(),
  },
});

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

test('RealtimeSessionManager matches two users and cleans up room', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io, { disconnectGraceMs: 25 });

  const aSocket = createFakeSocket('s-a');
  const bSocket = createFakeSocket('s-b');
  io.sockets.sockets.set('s-a', aSocket);
  io.sockets.sockets.set('s-b', bSocket);

  manager.registerSocket({ userId: 'u-a', socketId: 's-a' });
  manager.registerSocket({ userId: 'u-b', socketId: 's-b' });

  const aJoin = await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.equal(aJoin.matched, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);

  const bJoin = await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  assert.equal(bJoin.matched, true);

  const aSession = manager.getSession('u-a');
  const bSession = manager.getSession('u-b');
  assert.equal(aSession.state, SESSION_STATES.MATCHED);
  assert.equal(bSession.state, SESSION_STATES.MATCHED);
  assert.ok(aSession.roomId);
  assert.equal(aSession.roomId, bSession.roomId);

  assert.ok(aSocket.rooms.has(aSession.roomId));
  assert.ok(bSocket.rooms.has(aSession.roomId));
  assert.ok(aSocket.emitted.some((entry) => entry.event === 'match_found'));
  assert.ok(bSocket.emitted.some((entry) => entry.event === 'match_found'));

  manager.enterConversation({ userId: 'u-a', roomId: aSession.roomId });
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IN_CONVERSATION);

  await manager.leaveRoom({ userId: 'u-a', roomId: aSession.roomId, reason: 'test-leave' });

  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.IDLE);
  assert.ok(bSocket.emitted.some((entry) => entry.event === 'partner_left'));
});

test('RealtimeSessionManager disconnect cleanup ends ghost matchmaking', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io, { disconnectGraceMs: 20 });

  const socket = createFakeSocket('s-1');
  io.sockets.sockets.set('s-1', socket);
  manager.registerSocket({ userId: 'u-1', socketId: 's-1' });

  await manager.joinMatchmaking({ userId: 'u-1', bookId: 'book-2', prefType: 'text' });
  assert.equal(manager.getSession('u-1').state, SESSION_STATES.SEARCHING);

  manager.unregisterSocket({ socketId: 's-1' });
  io.sockets.sockets.delete('s-1');

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(manager.getSession('u-1').state, SESSION_STATES.IDLE);
  const searching = Array.from(manager.queue.values()).reduce((sum, queue) => sum + (queue?.length || 0), 0);
  assert.equal(searching, 0);
});

test('RealtimeSessionManager allows re-joining matchmaking from IN_CONVERSATION without an illegal transition (409)', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);

  const aSocket = createFakeSocket('s-a');
  const bSocket = createFakeSocket('s-b');
  io.sockets.sockets.set('s-a', aSocket);
  io.sockets.sockets.set('s-b', bSocket);
  manager.registerSocket({ userId: 'u-a', socketId: 's-a' });
  manager.registerSocket({ userId: 'u-b', socketId: 's-b' });

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const roomId = manager.getSession('u-a').roomId;
  manager.enterConversation({ userId: 'u-a', roomId });
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IN_CONVERSATION);

  // Re-joining while still IN_CONVERSATION must NOT throw a 409; it should reset
  // the prior session (notifying the partner) and start a fresh search.
  const rejoin = await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  assert.equal(rejoin.matched, false);
  assert.equal(manager.getSession('u-a').state, SESSION_STATES.SEARCHING);
  assert.ok(bSocket.emitted.some((entry) => entry.event === 'partner_left'));
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.IDLE);
});

test('RealtimeSessionManager enforces room membership for realtime relays', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);

  const aSocket = createFakeSocket('s-a');
  const bSocket = createFakeSocket('s-b');
  io.sockets.sockets.set('s-a', aSocket);
  io.sockets.sockets.set('s-b', bSocket);
  manager.registerSocket({ userId: 'u-a', socketId: 's-a' });
  manager.registerSocket({ userId: 'u-b', socketId: 's-b' });

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });
  await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  const roomId = manager.getSession('u-a').roomId;

  assert.equal(manager.isRoomMember('u-a', roomId), true);
  assert.equal(manager.isRoomMember('u-b', roomId), true);
  assert.equal(manager.isRoomMember('u-outsider', roomId), false);
  assert.equal(manager.isRoomMember('u-a', 'some-other-room'), false);
});

test('RealtimeSessionManager re-queues survivor when partner disconnects during match finalization', async () => {
  const io = createFakeIo();
  const manager = new RealtimeSessionManager(io);

  const aSocket = createFakeSocket('s-a');
  const bSocket = createFakeSocket('s-b');
  io.sockets.sockets.set('s-a', aSocket);
  io.sockets.sockets.set('s-b', bSocket);

  manager.registerSocket({ userId: 'u-a', socketId: 's-a' });
  manager.registerSocket({ userId: 'u-b', socketId: 's-b' });
  const baseFinalize = manager._finalizeMatch.bind(manager);
  manager._finalizeMatch = (match) => {
    io.sockets.sockets.delete(match.bSocketId);
    return baseFinalize(match);
  };

  const joinResult = await manager.joinMatchmaking({ userId: 'u-b', bookId: 'book-1', prefType: 'text' });
  assert.equal(joinResult.matched, false);

  await manager.joinMatchmaking({ userId: 'u-a', bookId: 'book-1', prefType: 'text' });

  assert.equal(manager.getSession('u-a').state, SESSION_STATES.IDLE);
  assert.equal(manager.getSession('u-b').state, SESSION_STATES.SEARCHING);
  assert.ok(bSocket.emitted.some((entry) => entry.event === 'match_requeued'));

  const searching = Array.from(manager.queue.values()).reduce((sum, queue) => sum + (queue?.length || 0), 0);
  assert.equal(searching, 1);
});
