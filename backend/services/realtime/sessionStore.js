import { SESSION_STATES } from '../../utils/sessionStates.js';
import { keys } from './keys.js';

const DELETE_SENTINEL = '__NULL__';

// Legal state machine. A transition to IDLE is always permitted (teardown), as
// is a self-transition (idempotent re-entry).
const TRANSITIONS = Object.freeze({
  [SESSION_STATES.IDLE]: [SESSION_STATES.SEARCHING],
  [SESSION_STATES.SEARCHING]: [SESSION_STATES.MATCHED],
  [SESSION_STATES.MATCHED]: [SESSION_STATES.IN_CONVERSATION],
  [SESSION_STATES.IN_CONVERSATION]: [],
});

const TRANSITIONS_JSON = JSON.stringify(TRANSITIONS);

// The FSM guard and the write must be one atomic step. REST traffic round-robins
// across instances, so two requests for the same user can land on two processes
// concurrently; a read-validate-write in JS would interleave and admit an
// illegal transition. Redis executes a script to completion before serving the
// next command, which makes the guard sound cluster-wide.
const SET_STATE_LUA = `
local from = redis.call('HGET', KEYS[1], 'state')
if not from then from = ARGV[5] end
local to = ARGV[1]

local allowed = (to == ARGV[5]) or (from == to)
if not allowed then
  local table_ = cjson.decode(ARGV[3])
  local targets = table_[from]
  if targets then
    for _, candidate in ipairs(targets) do
      if candidate == to then allowed = true end
    end
  end
end

if not allowed then
  return redis.error_reply('INVALID_TRANSITION ' .. from .. ' -> ' .. to)
end

redis.call('HSET', KEYS[1], 'state', to, 'updatedAt', ARGV[6])
local patch = cjson.decode(ARGV[2])
for field, value in pairs(patch) do
  if value == ARGV[7] then
    redis.call('HDEL', KEYS[1], field)
  else
    redis.call('HSET', KEYS[1], field, value)
  end
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return redis.call('HGETALL', KEYS[1])
`;

const UPSERT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'state', ARGV[3], 'createdAt', ARGV[4])
end
local patch = cjson.decode(ARGV[1])
for field, value in pairs(patch) do
  if value == ARGV[5] then
    redis.call('HDEL', KEYS[1], field)
  else
    redis.call('HSET', KEYS[1], field, value)
  end
end
redis.call('HSET', KEYS[1], 'updatedAt', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return redis.call('HGETALL', KEYS[1])
`;

const normalizeId = (value) => String(value || '').trim();

/** Redis returns hashes as a flat [field, value, ...] array. */
const toSession = (flat, userId) => {
  if (!flat || flat.length === 0) return null;
  const session = { userId };
  for (let i = 0; i < flat.length; i += 2) session[flat[i]] = flat[i + 1];
  return session;
};

/** cjson cannot express "delete this field", so nulls become a sentinel string. */
const encodePatch = (patch) => {
  const encoded = {};
  for (const [field, value] of Object.entries(patch)) {
    encoded[field] = value === null || value === undefined ? DELETE_SENTINEL : String(value);
  }
  return JSON.stringify(encoded);
};

export class SessionStore {
  constructor(redis, { ttlMs = 30 * 60 * 1000 } = {}) {
    this.redis = redis;
    this.ttlMs = ttlMs;

    // Registered once; ioredis handles EVALSHA/EVAL fallback and re-loading.
    this.redis.defineCommand('sessionSetState', { numberOfKeys: 1, lua: SET_STATE_LUA });
    this.redis.defineCommand('sessionUpsert', { numberOfKeys: 1, lua: UPSERT_LUA });
  }

  async get(userId) {
    const key = normalizeId(userId);
    if (!key) return null;
    const flat = await this.redis.hgetall(keys.session(key));
    const entries = Object.entries(flat);
    if (entries.length === 0) return null;
    return { userId: key, ...flat };
  }

  async upsert(userId, patch = {}) {
    const key = normalizeId(userId);
    if (!key) throw new Error('userId is required');

    const flat = await this.redis.sessionUpsert(
      keys.session(key),
      encodePatch(patch),
      String(this.ttlMs),
      SESSION_STATES.IDLE,
      String(Date.now()),
      DELETE_SENTINEL,
    );
    return toSession(flat, key);
  }

  async setState(userId, state, extra = {}) {
    const key = normalizeId(userId);
    const target = normalizeId(state);
    if (!Object.values(SESSION_STATES).includes(target)) {
      throw new Error(`Invalid session state: ${state}`);
    }

    try {
      const flat = await this.redis.sessionSetState(
        keys.session(key),
        target,
        encodePatch(extra),
        TRANSITIONS_JSON,
        String(this.ttlMs),
        SESSION_STATES.IDLE,
        String(Date.now()),
        DELETE_SENTINEL,
      );
      return toSession(flat, key);
    } catch (error) {
      if (String(error.message).includes('INVALID_TRANSITION')) {
        const conflict = new Error(`Invalid session transition: ${error.message.split('INVALID_TRANSITION ')[1]}`);
        conflict.code = 'INVALID_TRANSITION';
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }
  }

  async clear(userId) {
    const key = normalizeId(userId);
    if (!key) return false;
    return (await this.redis.del(keys.session(key))) > 0;
  }
}
