const crypto = require('crypto');
const { hashPassword, validatePassword } = require('./passwords');
const { ConfigError } = require('./config');

// SHA-256 fingerprints of password hashes that were published in the old seed
// users.json. An account still carrying one of them has a publicly known
// password, so its password is disabled until it is reset.
const PUBLISHED_SEED_FINGERPRINTS = new Set([
  '15997611b55d7ccdc48cefc339b276679d965b07a126e650a23be9a5a94842fd'
]);

function fingerprint(hash) {
  return crypto.createHash('sha256').update(hash).digest('hex');
}

async function ensureAdminAccount(store, { username, initialPassword }, {
  logger = console,
  seedFingerprints = PUBLISHED_SEED_FINGERPRINTS
} = {}) {
  const data = store.load();
  const result = { created: false, reset: false, disabled: [] };

  for (const user of data.users) {
    if (user.password && seedFingerprints.has(fingerprint(user.password))) {
      user.password = null;
      user.mustChangePassword = true;
      result.disabled.push(user.username);
      logger.warn(`[security] Account "${user.username}" still used the published default password; its password has been disabled.`);
    }
  }

  const hasUsableAdmin = data.users.some(u => u.role === 'admin' && u.password);

  if (!hasUsableAdmin) {
    if (!initialPassword) {
      const message = 'No admin account with a usable password exists. Set ADMIN_INITIAL_PASSWORD and restart to (re)initialise it.';
      if (data.users.length === 0) throw new ConfigError(message);
      logger.error(`[security] ${message}`);
    } else {
      const problem = validatePassword(initialPassword, { username });
      if (problem) throw new ConfigError(`ADMIN_INITIAL_PASSWORD rejected: ${problem}`);

      const hash = await hashPassword(initialPassword);
      let admin = data.users.find(u => u.username === username);
      if (admin) {
        admin.password = hash;
        admin.role = 'admin';
        result.reset = true;
      } else {
        admin = { id: crypto.randomUUID(), username, password: hash, role: 'admin', allowedContainers: [] };
        data.users.push(admin);
        result.created = true;
      }
      admin.mustChangePassword = true;
      logger.warn(`[security] Admin account "${username}" initialised from ADMIN_INITIAL_PASSWORD; a new password must be chosen at first login.`);
    }
  } else if (initialPassword) {
    logger.warn('[security] ADMIN_INITIAL_PASSWORD is set but an admin account already exists, so it was ignored. Remove it from the environment.');
  }

  if (result.created || result.reset || result.disabled.length > 0) {
    store.save(data);
  }
  return result;
}

// "*" used to grant regular users every container. It is now reserved for
// admins (who do not need it), so strip it from stored grants instead of
// letting the UI show access the server no longer honours.
function removeUserWildcardGrants(store, { logger = console } = {}) {
  const data = store.load();
  const affected = [];

  for (const user of data.users) {
    if (user.role !== 'admin' && Array.isArray(user.allowedContainers) && user.allowedContainers.includes('*')) {
      user.allowedContainers = user.allowedContainers.filter(entry => entry !== '*');
      affected.push(user.username);
      logger.warn(`[security] Removed the "*" (all containers) grant from non-admin user "${user.username}"; grant containers explicitly.`);
    }
  }

  if (affected.length > 0) store.save(data);
  return affected;
}

module.exports = { ensureAdminAccount, removeUserWildcardGrants, fingerprint, PUBLISHED_SEED_FINGERPRINTS };
