const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;
// bcrypt silently ignores everything past 72 bytes
const MAX_PASSWORD_BYTES = 72;

// Returns an error message, or null when the password is acceptable
function validatePassword(password, { username } = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  if (username && String(username).length >= 3 &&
      password.toLowerCase().includes(String(username).toLowerCase())) {
    return 'Password must not contain the username';
  }
  if (new Set(password).size < 5) {
    return 'Password is too repetitive';
  }
  return null;
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Unknown or disabled accounts are compared against a throwaway hash so the
// response time does not reveal which usernames exist.
const decoyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || !password) return false;
  if (!hash) {
    await bcrypt.compare(password, decoyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}

module.exports = { validatePassword, hashPassword, verifyPassword, MIN_PASSWORD_LENGTH };
