import { keys } from './keys.js';

/**
 * Enqueue a reader and, if a partner is already waiting, pair them.
 *
 * This must be atomic across instances: with N backends, two readers calling
 * join at the same moment are handled by two processes. A JS-side lock (as the
 * previous single-process implementation used) cannot serialise them, so both
 * would observe an empty queue and neither would match. Redis runs a script to
 * completion before any other command, so the enqueue-and-pair decision is a
 * single indivisible step.
 *
 * Any prior entry for the same user is removed first, which makes join
 * idempotent and stops a multi-tab user from being matched with themselves.
 */
const ENQUEUE_AND_PAIR_LUA = `
local queueKey = KEYS[1]
local seqKey = KEYS[2]
local searchingKey = KEYS[3]
local userId = ARGV[1]
local entry = ARGV[2]
local bookId = ARGV[3]

-- Drop any stale entry for this user (re-queue / multi-tab).
local existing = redis.call('LRANGE', queueKey, 0, -1)
for _, raw in ipairs(existing) do
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded.userId == userId then
    redis.call('LREM', queueKey, 0, raw)
  end
end

redis.call('RPUSH', queueKey, entry)
redis.call('SADD', searchingKey, userId)

if redis.call('LLEN', queueKey) < 2 then
  return nil
end

local a = redis.call('LPOP', queueKey)
local b = redis.call('LPOP', queueKey)

local seq = redis.call('INCR', seqKey)
-- The room id MUST be unique per pairing, not per book: deriving it from the
-- book alone would drop every pair reading that book into one shared room.
local roomId = bookId .. '#' .. seq

local decodedA = cjson.decode(a)
local decodedB = cjson.decode(b)
redis.call('SREM', searchingKey, decodedA.userId)
redis.call('SREM', searchingKey, decodedB.userId)

if redis.call('LLEN', queueKey) == 0 then
  redis.call('DEL', queueKey)
end

return { a, b, roomId }
`;

const REMOVE_LUA = `
local queueKey = KEYS[1]
local searchingKey = KEYS[2]
local userId = ARGV[1]
local removed = 0

local existing = redis.call('LRANGE', queueKey, 0, -1)
for _, raw in ipairs(existing) do
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded.userId == userId then
    removed = removed + redis.call('LREM', queueKey, 0, raw)
  end
end

redis.call('SREM', searchingKey, userId)
if redis.call('LLEN', queueKey) == 0 then
  redis.call('DEL', queueKey)
end
return removed
`;

export class MatchmakingQueue {
  constructor(redis) {
    this.redis = redis;
    this.redis.defineCommand('queueEnqueueAndPair', { numberOfKeys: 3, lua: ENQUEUE_AND_PAIR_LUA });
    this.redis.defineCommand('queueRemove', { numberOfKeys: 2, lua: REMOVE_LUA });
  }

  static queueKeyFor(bookId, prefType) {
    return `${bookId}_${prefType}`;
  }

  /** @returns {Promise<null | {roomId, a, b}>} null when the reader is left waiting. */
  async enqueueAndPair({ userId, displayName, bookId, prefType }) {
    const queueKey = MatchmakingQueue.queueKeyFor(bookId, prefType);
    const entry = JSON.stringify({ userId, displayName, bookId, prefType, queuedAt: Date.now() });

    const result = await this.redis.queueEnqueueAndPair(
      keys.queue(queueKey),
      keys.roomSequence,
      keys.searching,
      userId,
      entry,
      bookId,
    );

    if (!result) return null;
    const [rawA, rawB, roomId] = result;
    return { roomId, a: JSON.parse(rawA), b: JSON.parse(rawB) };
  }

  /** Re-inserts a reader at the head of the queue after a failed pairing. */
  async requeueFront({ userId, displayName, bookId, prefType }) {
    const queueKey = MatchmakingQueue.queueKeyFor(bookId, prefType);
    const entry = JSON.stringify({ userId, displayName, bookId, prefType, queuedAt: Date.now() });
    await this.redis
      .multi()
      .lpush(keys.queue(queueKey), entry)
      .sadd(keys.searching, userId)
      .exec();
  }

  async remove({ userId, bookId, prefType }) {
    const queueKey = MatchmakingQueue.queueKeyFor(bookId, prefType);
    return this.redis.queueRemove(keys.queue(queueKey), keys.searching, userId);
  }

  /** Cluster-wide count of readers currently waiting. */
  async searchingCount() {
    return this.redis.scard(keys.searching);
  }

  async dropFromSearching(userId) {
    await this.redis.srem(keys.searching, userId);
  }
}
