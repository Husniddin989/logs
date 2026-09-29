// In-memory throttle for password checks. Counting per (account, client IP)
// stops password guessing without letting an attacker lock the real user out
// from elsewhere; a separate per-IP budget catches one client spraying many
// usernames.
function createLoginThrottle({
  maxFailuresPerAccount = 5,
  maxFailuresPerIp = 20,
  windowMs = 15 * 60 * 1000,
  lockMs = 15 * 60 * 1000,
  maxEntries = 10000,
  now = () => Date.now()
} = {}) {
  // key -> { failures, windowStart, lockedUntil, inFlight }
  const entries = new Map();

  const keysFor = (account, ip) => [
    { key: `acct:${String(account).slice(0, 64)}|${ip}`, limit: maxFailuresPerAccount },
    { key: `ip:${ip}`, limit: maxFailuresPerIp }
  ];

  function entryFor(key, time) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { failures: 0, windowStart: time, lockedUntil: 0, inFlight: 0 };
      entries.set(key, entry);
    } else if (entry.windowStart + windowMs <= time) {
      entry.failures = 0;
      entry.windowStart = time;
    }
    return entry;
  }

  function prune(time) {
    for (const [key, entry] of entries) {
      if (entry.inFlight === 0 && entry.lockedUntil <= time && entry.windowStart + windowMs <= time) {
        entries.delete(key);
      }
    }
    // Still too many: drop the oldest idle entries so memory stays bounded
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (entry.inFlight === 0) entries.delete(key);
    }
  }

  // Reserves an attempt *before* the slow password check, so concurrent
  // requests cannot all pass the limit while the first ones are still being
  // verified. Returns { retryAfter } (seconds) when the attempt is refused;
  // otherwise call finish(true | false) once the outcome is known, or
  // finish() to release the reservation without counting it.
  function begin(account, ip) {
    const time = now();
    const keys = keysFor(account, ip);

    let wait = 0;
    for (const { key, limit } of keys) {
      const entry = entryFor(key, time);
      if (entry.lockedUntil > time) {
        wait = Math.max(wait, Math.ceil((entry.lockedUntil - time) / 1000));
      } else if (entry.failures + entry.inFlight >= limit) {
        // Enough attempts are already being checked to reach the limit
        wait = Math.max(wait, 1);
      }
    }
    if (wait > 0) return { retryAfter: wait, finish() {} };

    keys.forEach(({ key }) => { entries.get(key).inFlight += 1; });
    if (entries.size > maxEntries) prune(time);

    let finished = false;
    return {
      retryAfter: 0,
      finish(success) {
        if (finished) return;
        finished = true;
        const doneAt = now();
        for (const { key, limit } of keys) {
          const entry = entryFor(key, doneAt);
          entry.inFlight = Math.max(0, entry.inFlight - 1);
          if (success === false) {
            entry.failures += 1;
            if (entry.failures >= limit) entry.lockedUntil = doneAt + lockMs;
          }
        }
        // A correct password clears that account's counter for this client
        // only; failures against other accounts from the same IP still count.
        if (success === true) {
          const account = entries.get(keys[0].key);
          account.failures = 0;
          account.lockedUntil = 0;
        }
      }
    };
  }

  return { begin };
}

module.exports = { createLoginThrottle };
