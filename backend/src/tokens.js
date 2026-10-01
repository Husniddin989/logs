const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const ISSUER = 'docker-log-viewer';
const AUDIENCE = 'docker-log-viewer';
const ALGORITHM = 'HS256';
const PASSWORD_CHANGE_SCOPE = 'password_change';
const PASSWORD_CHANGE_TTL_SECONDS = 10 * 60;
// Short-lived proof that an admin re-entered the password, required for
// start / stop / restart / remove of containers. Never accepted as a
// session token.
const CONTAINER_ACTIONS_SCOPE = 'container_actions';
const CONTAINER_ACTIONS_TTL_SECONDS = 5 * 60;

class TokenError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// Tokens carry:
//   ver       - the user's tokenVersion; bumping it revokes every token of
//               that user (password change, "sign out everywhere", admin)
//   jti       - unique ID; a single token can be revoked (logout)
//   auth_time - when the password was last proven; refreshes keep it, so a
//               session can slide but never outlive sessionMaxAgeSeconds
function createTokenService({
  secret,
  accessTtlSeconds,
  sessionMaxAgeSeconds,
  revocationFile = null,
  now = () => Date.now()
}) {
  const nowSeconds = () => Math.floor(now() / 1000);
  const revoked = loadRevocations(revocationFile); // jti -> exp

  function sign(user, { authTime, scope, ttl }) {
    const iat = nowSeconds();
    const claims = {
      sub: user.id,
      username: user.username,
      role: user.role,
      ver: user.tokenVersion || 0,
      auth_time: authTime,
      iat,
      exp: Math.min(iat + ttl, authTime + sessionMaxAgeSeconds)
    };
    if (scope) claims.scope = scope;
    return jwt.sign(claims, secret, {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: crypto.randomUUID()
    });
  }

  function issueSession(user, { authTime = nowSeconds() } = {}) {
    if (authTime + sessionMaxAgeSeconds <= nowSeconds()) {
      throw new TokenError('session_expired');
    }
    return sign(user, { authTime, ttl: accessTtlSeconds });
  }

  function issuePasswordChange(user) {
    return sign(user, { authTime: nowSeconds(), scope: PASSWORD_CHANGE_SCOPE, ttl: PASSWORD_CHANGE_TTL_SECONDS });
  }

  // Bound to the session's auth_time, so it dies with the session
  function issueContainerActions(user, { authTime }) {
    return sign(user, { authTime, scope: CONTAINER_ACTIONS_SCOPE, ttl: CONTAINER_ACTIONS_TTL_SECONDS });
  }

  function verify(token) {
    let claims;
    try {
      claims = jwt.verify(token, secret, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTimestamp: nowSeconds()
      });
    } catch (error) {
      throw new TokenError(error.name === 'TokenExpiredError' ? 'expired' : 'invalid');
    }

    if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string' ||
        !Number.isInteger(claims.ver) || !Number.isInteger(claims.auth_time)) {
      throw new TokenError('invalid');
    }
    if (revoked.has(claims.jti)) {
      throw new TokenError('revoked');
    }
    return claims;
  }

  function revoke(claims) {
    revoked.set(claims.jti, claims.exp);
    const current = nowSeconds();
    for (const [jti, exp] of revoked) {
      if (exp < current) revoked.delete(jti);
    }
    persistRevocations(revocationFile, revoked);
  }

  function sessionExpired(claims) {
    return claims.auth_time + sessionMaxAgeSeconds <= nowSeconds();
  }

  return {
    issueSession,
    issuePasswordChange,
    issueContainerActions,
    verify,
    revoke,
    sessionExpired,
    accessTtlSeconds,
    containerActionsTtlSeconds: CONTAINER_ACTIONS_TTL_SECONDS
  };
}

function loadRevocations(file) {
  if (!file) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

function persistRevocations(file, revoked) {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { createTokenService, TokenError, PASSWORD_CHANGE_SCOPE, CONTAINER_ACTIONS_SCOPE };
