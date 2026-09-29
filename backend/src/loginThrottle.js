// In-memory throttle for failed password checks. Counting per
// (account, client IP) stops password guessing without letting an attacker
// lock the real user out from elsewhere; a separate per-IP budget catches
// one client spraying many usernames.
function createLoginThrottle({
  maxFailuresPerAccount = 5,
  maxFailuresPerIp = 20,
  windowMs = 15 * 60 * 1000,
  lockMs = 15 * 60 * 1000,
  maxEntries = 10000,
  now = () => Date.now()
} = {}) {
  const entries = new Map(); // key -> { count, windowStart, lockedUntil }

  const keysFor = (account, ip) => [
    { key: `acct:${String(account).slice(0, 64)}|${ip}`, limit: maxFailuresPerAccount },
    { key: `ip:${ip}`, limit: maxFailuresPerIp }
  ];

  function prune(time) {
    for (const [key, entry] of entries) {
      if (entry.lockedUntil <= time && entry.windowStart + windowMs <= time) entries.delete(key);
    }
    // Still too many: drop the oldest so memory stays bounded
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  // Returns the number of seconds to wait, or 0 when the attempt may proceed
  function retryAfter(account, ip) {
    const time = now();
    let wait = 0;
    for (const { key } of keysFor(account, ip)) {
      const entry = entries.get(key);
      if (entry && entry.lockedUntil > time) {
        wait = Math.max(wait, Math.ceil((entry.lockedUntil - time) / 1000));
      }
    }
    return wait;
  }

  function recordFailure(account, ip) {
    const time = now();
    for (const { key, limit } of keysFor(account, ip)) {
      let entry = entries.get(key);
      if (!entry || entry.windowStart + windowMs <= time) {
        entry = { count: 0, windowStart: time, lockedUntil: 0 };
      }
      entry.count += 1;
      if (entry.count >= limit) entry.lockedUntil = time + lockMs;
      entries.delete(key);
      entries.set(key, entry);
    }
    if (entries.size > maxEntries) prune(time);
  }

  // A correct password clears that account's counter for this client only;
  // failures against other accounts from the same IP still count.
  function recordSuccess(account, ip) {
    entries.delete(keysFor(account, ip)[0].key);
  }

  return { retryAfter, recordFailure, recordSuccess };
}

module.exports = { createLoginThrottle };
