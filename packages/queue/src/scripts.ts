// KEYS: 1 schedule zset, 2 jobs stream, 3 intervals hash
// ARGV: 1 now (ms), 2 batch limit, 3 stream max length
export const CLAIM_DUE = `
local now = tonumber(ARGV[1])
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))
local claimed = 0
for i = 1, #due, 2 do
  local id = due[i]
  local slot = tonumber(due[i + 1])
  local interval = tonumber(redis.call('HGET', KEYS[3], id))
  if interval then
    local nextRun = slot + interval
    if nextRun <= now then nextRun = now + interval end
    redis.call('ZADD', KEYS[1], nextRun, id)
    redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], '*',
      'monitor_id', id,
      'slot', string.format('%.0f', slot),
      'interval_ms', string.format('%.0f', interval))
    claimed = claimed + 1
  else
    redis.call('ZREM', KEYS[1], id)
  end
end
return claimed`;

// Delete the lock only if we still own it.
export const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
