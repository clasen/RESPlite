export const USERNAME_SCRIPT = `
local hid = ARGV[1]
local current = redis.call('HGET', KEYS[1], hid)
if current and redis.call('HGET', KEYS[2], string.lower(current)) ~= hid then
    return redis.error_reply('inconsistent username owner')
end
if ARGV[2] == 'ensure' and current then return current end
for i = 3, #ARGV do
    local username = ARGV[i]
    local normalized = string.lower(username)
    local owner = redis.call('HGET', KEYS[2], normalized)
    if not owner or owner == hid then
        if current and string.lower(current) ~= normalized then
            redis.call('HDEL', KEYS[2], string.lower(current))
        end
        redis.call('HSET', KEYS[1], hid, username)
        redis.call('HSET', KEYS[2], normalized, hid)
        return username
    end
end
return false
`;
