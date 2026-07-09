import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { io as ioc } from 'socket.io-client';

import { RealtimeSessionManager } from '../services/realtimeSessionManager.js';
import { createRedisClients } from '../services/realtime/redisClients.js';
import { keys, userChannel } from '../services/realtime/keys.js';
import { SESSION_STATES } from '../utils/sessionStates.js';

// Redis is a hard dependency of the realtime layer, so these are integration
// tests. REDIS_TEST_URL must point at a throwaway database: it is flushed per test.
const REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6379/15';
const BOOK = { bookId: 'book-1', prefType: 'text' };

/** One backend instance: http server + socket.io + a manager, all sharing Redis. */
const startInstance = async (redisUrl) => {
  const clients = await createRedisClients(redisUrl);
  const httpServer = createServer();
  const io = new Server(httpServer);
  io.adapter(createAdapter(clients.pub, clients.sub));

  const manager = new RealtimeSessionManager(io, clients.data);

  io.on('connection', async (socket) => {
    socket.userId = String(socket.handshake.auth.userId);
    socket.displayName = String(socket.handshake.auth.displayName || 'Reader');
    await manager.registerSocket(socket);
    socket.emit('ready');
    socket.on('disconnect', () => { manager.unregisterSocket(socket, 'disconnect').catch(() => {}); });
  });

  httpServer.listen(0);
  await once(httpServer, 'listening');

  return {
    manager,
    io,
    port: httpServer.address().port,
    close: async () => {
      // Disconnect handlers write to Redis, so they must finish draining before
      // the clients are torn down or they reject with "Connection is closed".
      io.disconnectSockets(true);
      await new Promise((resolve) => { io.close(resolve); });
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      await clients.close();
    },
  };
};

const connect = async (port, userId, displayName = 'Reader') => {
  const socket = ioc(`http://127.0.0.1:${port}`, {
    auth: { userId, displayName },
    transports: ['websocket'],
    reconnection: false,
  });
  await once(socket, 'ready');
  return socket;
};

const waitFor = (socket, event, ms = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), ms);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

let one;
let two;
let adminClients;
let admin;

before(async () => {
  one = await startInstance(REDIS_URL);
  two = await startInstance(REDIS_URL);
  adminClients = await createRedisClients(REDIS_URL);
  admin = adminClients.data;
});

after(async () => {
  await one.close();
  await two.close();
  await adminClients.close();
});

beforeEach(async () => {
  await admin.flushdb();
});

/** No queue, room or presence key may survive a completed interaction. */
const assertNoResidualState = async () => {
  for (const pattern of ['alp:rt:queue:*', 'alp:rt:room:*', 'alp:rt:userroom:*', 'alp:rt:userqueue:*']) {
    const found = await admin.keys(pattern);
    assert.deepEqual(found, [], `${pattern} should be empty, found ${found.join(',')}`);
  }
  assert.equal(await admin.scard(keys.searching), 0, 'searching set should be empty');
};

test('pairs two readers connected to different instances', async () => {
  const a = await connect(one.port, 'u-a', 'Ada');
  const b = await connect(two.port, 'u-b', 'Bo');

  const matchA = waitFor(a, 'match_found');
  const matchB = waitFor(b, 'match_found');

  const first = await one.manager.joinMatchmaking({ userId: 'u-a', displayName: 'Ada', ...BOOK });
  assert.equal(first.matched, false);
  assert.equal((await one.manager.getSession('u-a')).state, SESSION_STATES.SEARCHING);

  const second = await two.manager.joinMatchmaking({ userId: 'u-b', displayName: 'Bo', ...BOOK });
  assert.equal(second.matched, true);

  const [payloadA, payloadB] = await Promise.all([matchA, matchB]);
  assert.equal(payloadA.roomId, payloadB.roomId);
  assert.notEqual(payloadA.role, payloadB.role);
  assert.equal(payloadA.partnerUsername, 'Bo');

  const sessionA = await one.manager.getSession('u-a');
  const sessionB = await two.manager.getSession('u-b');
  assert.equal(sessionA.state, SESSION_STATES.MATCHED);
  assert.equal(sessionB.state, SESSION_STATES.MATCHED);
  assert.equal(sessionA.roomId, sessionB.roomId);

  // Both sockets joined the room, across instances.
  const members = await one.io.in(sessionA.roomId).fetchSockets();
  assert.equal(members.length, 2);

  await one.manager.enterConversation({ userId: 'u-a', roomId: sessionA.roomId });
  assert.equal((await one.manager.getSession('u-a')).state, SESSION_STATES.IN_CONVERSATION);

  const partnerLeft = waitFor(b, 'partner_left');
  await one.manager.leaveRoom({ userId: 'u-a', roomId: sessionA.roomId, reason: 'left' });
  await partnerLeft;

  assert.equal((await one.manager.getSession('u-a')).state, SESSION_STATES.IDLE);
  assert.equal((await two.manager.getSession('u-b')).state, SESSION_STATES.IDLE);

  a.close(); b.close();
  await assertNoResidualState();
});

test('a disconnect drains the queue and ends the ghost session', async () => {
  const a = await connect(one.port, 'u-1');
  await one.manager.joinMatchmaking({ userId: 'u-1', ...BOOK });
  assert.equal((await one.manager.getSession('u-1')).state, SESSION_STATES.SEARCHING);
  assert.equal(await one.manager.searchingCount(), 1);

  a.close();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal((await one.manager.getSession('u-1')).state, SESSION_STATES.IDLE);
  assert.equal(await one.manager.searchingCount(), 0);
  await assertNoResidualState();
});

test('re-joining from IN_CONVERSATION is legal and frees the partner', async () => {
  const a = await connect(one.port, 'u-a');
  const b = await connect(two.port, 'u-b');

  await one.manager.joinMatchmaking({ userId: 'u-a', ...BOOK });
  await two.manager.joinMatchmaking({ userId: 'u-b', ...BOOK });
  const { roomId } = await one.manager.getSession('u-a');

  await one.manager.enterConversation({ userId: 'u-a', roomId });
  assert.equal((await one.manager.getSession('u-a')).state, SESSION_STATES.IN_CONVERSATION);

  const partnerLeft = waitFor(b, 'partner_left');
  // Must not raise a 409 illegal transition: join force-idles first.
  const rejoin = await one.manager.joinMatchmaking({ userId: 'u-a', ...BOOK });
  assert.equal(rejoin.matched, false);
  assert.equal((await one.manager.getSession('u-a')).state, SESSION_STATES.SEARCHING);
  await partnerLeft;

  a.close(); b.close();
});

test('a reader is never matched with themselves across two tabs', async () => {
  const tab1 = await connect(one.port, 'u-solo');
  const tab2 = await connect(two.port, 'u-solo');

  const first = await one.manager.joinMatchmaking({ userId: 'u-solo', ...BOOK });
  const second = await two.manager.joinMatchmaking({ userId: 'u-solo', ...BOOK });

  assert.equal(first.matched, false);
  assert.equal(second.matched, false, 'the duplicate entry must replace, not pair');
  assert.equal(await one.manager.searchingCount(), 1);

  tab1.close(); tab2.close();
});

test('concurrent joins across instances yield disjoint pairs and no residue', async () => {
  const userIds = Array.from({ length: 10 }, (_, index) => `u-${index}`);
  const sockets = await Promise.all(userIds.map((userId, index) => connect(index % 2 ? two.port : one.port, userId)));

  const matched = new Map();
  const listeners = sockets.map((socket, index) => new Promise((resolve) => {
    socket.once('match_found', ({ roomId }) => { matched.set(userIds[index], roomId); resolve(); });
    setTimeout(resolve, 4000);
  }));

  // Fire every join at once, alternating which instance handles it.
  await Promise.all(userIds.map((userId, index) => (index % 2 ? two : one).manager
    .joinMatchmaking({ userId, ...BOOK })));
  await Promise.all(listeners);

  assert.equal(matched.size, 10, `every reader should be paired, got ${matched.size}`);
  const rooms = [...new Set(matched.values())];
  assert.equal(rooms.length, 5, 'ten readers must form five distinct rooms');
  for (const room of rooms) {
    const occupants = [...matched.entries()].filter(([, id]) => id === room);
    assert.equal(occupants.length, 2, `room ${room} must hold exactly two readers`);
  }
  assert.equal(await one.manager.searchingCount(), 0);

  await Promise.all([...matched.keys()].map((userId) => one.manager.endSession(userId)));
  sockets.forEach((socket) => socket.close());
  await assertNoResidualState();
});

test('a matched reader survives a reconnect and rejoins their room', async () => {
  const a = await connect(one.port, 'u-a');
  const b = await connect(two.port, 'u-b');
  await one.manager.joinMatchmaking({ userId: 'u-a', ...BOOK });
  await two.manager.joinMatchmaking({ userId: 'u-b', ...BOOK });
  const { roomId } = await one.manager.getSession('u-a');

  a.close();
  await new Promise((resolve) => { setTimeout(resolve, 300); });

  // Within the grace window the room and session must still exist.
  assert.equal((await one.manager.getSession('u-a')).state, SESSION_STATES.MATCHED);
  assert.equal(await one.manager.isRoomMember('u-a', roomId), true);

  // The reconnecting socket must be put back into the room, on any instance.
  const back = await connect(two.port, 'u-a');
  const members = await two.io.in(roomId).fetchSockets();
  assert.equal(members.length, 2, 'reconnected socket must rejoin the room');

  const partnerLeft = waitFor(b, 'partner_left');
  await two.manager.leaveRoom({ userId: 'u-a', roomId, reason: 'left' });
  await partnerLeft;

  back.close(); b.close();
});

test('the state machine rejects an illegal transition atomically', async () => {
  await one.manager.ensureSession('u-x');
  await assert.rejects(
    () => one.manager.setSessionState('u-x', SESSION_STATES.MATCHED),
    (error) => error.statusCode === 409 && error.code === 'INVALID_TRANSITION',
  );
  assert.equal((await one.manager.getSession('u-x')).state, SESSION_STATES.IDLE);
});

test('room membership gates relays', async () => {
  const a = await connect(one.port, 'u-a');
  const b = await connect(two.port, 'u-b');
  await one.manager.joinMatchmaking({ userId: 'u-a', ...BOOK });
  await two.manager.joinMatchmaking({ userId: 'u-b', ...BOOK });
  const { roomId } = await one.manager.getSession('u-a');

  assert.equal(await one.manager.isRoomMember('u-a', roomId), true);
  assert.equal(await one.manager.isRoomMember('u-stranger', roomId), false);
  assert.equal(await one.manager.isRoomMember('u-a', 'book-1#999'), false);

  a.close(); b.close();
});

test('presence is visible from any instance', async () => {
  const a = await connect(one.port, 'u-a');
  assert.equal(await two.manager.isOnline('u-a'), true, "instance two must see instance one's socket");
  assert.equal(await two.manager.isOnline('u-ghost'), false);

  const sockets = await two.io.in(userChannel('u-a')).fetchSockets();
  assert.equal(sockets.length, 1);

  a.close();
});
