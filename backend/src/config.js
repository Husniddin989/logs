const crypto = require('crypto');
const path = require('path');

class ConfigError extends Error {}

// SHA-256 fingerprints of JWT secrets that were published as defaults in
// this repository (code, docker-compose.yml, .env.example). Anyone can forge
// tokens with them, so they are refused like a missing secret.
const PUBLISHED_SECRET_FINGERPRINTS = new Set([
  '415bf5de586c91a305c2065b66efeb239cead6f129143c7589d2ea4fbd46643c',
  'aac54529679c74b8f265d02181bfb7f9f1f2449c8a6c61200523b85ee59843c3',
  '103ab5dd9769664c34bb4dcecdbe1aa52a55f75a4a62243238c9abb3bc3d9e02'
]);

const MIN_SECRET_LENGTH = 32;

function validateJwtSecret(secret) {
  const hint = 'Generate one with: openssl rand -base64 48';
  if (!secret) {
    throw new ConfigError(`JWT_SECRET is required. ${hint}`);
  }
  if (PUBLISHED_SECRET_FINGERPRINTS.has(crypto.createHash('sha256').update(secret).digest('hex'))) {
    throw new ConfigError(`JWT_SECRET is a value published in the repository and must be replaced. ${hint}`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters. ${hint}`);
  }
  if (new Set(secret).size < 10) {
    throw new ConfigError(`JWT_SECRET is not random enough. ${hint}`);
  }
  return secret;
}

// Accepts plain seconds or a number with an s/m/h/d suffix ("15m", "12h")
function parseDuration(value, name) {
  const match = /^(\d+)\s*([smhd]?)$/.exec(String(value).trim());
  if (!match) throw new ConfigError(`${name} must look like 900, 15m, 12h or 7d`);
  const seconds = Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  if (seconds <= 0) throw new ConfigError(`${name} must be positive`);
  return seconds;
}

// Which proxies may set X-Forwarded-For (Express "trust proxy" syntax). The
// default trusts private-network hops only - the frontend nginx container and
// a reverse proxy on the Docker host - so the client IP in audit logs is the
// first public address and cannot be spoofed by a client-supplied header.
function parseTrustProxy(value) {
  if (value === undefined || value === '') return 'loopback, linklocal, uniquelocal';
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function loadConfig(env = process.env) {
  const accessTtlSeconds = parseDuration(env.JWT_ACCESS_TTL || '15m', 'JWT_ACCESS_TTL');
  const sessionMaxAgeSeconds = parseDuration(env.SESSION_MAX_AGE || '12h', 'SESSION_MAX_AGE');
  if (accessTtlSeconds > sessionMaxAgeSeconds) {
    throw new ConfigError('JWT_ACCESS_TTL must not exceed SESSION_MAX_AGE');
  }

  return {
    port: Number(env.PORT) || 2001,
    dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
    dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
    auditLogFile: env.AUDIT_LOG_FILE || null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
    admin: {
      username: (env.ADMIN_USERNAME || 'admin').trim(),
      initialPassword: env.ADMIN_INITIAL_PASSWORD || null
    },
    jwt: {
      secret: validateJwtSecret(env.JWT_SECRET),
      accessTtlSeconds,
      sessionMaxAgeSeconds
    }
  };
}

module.exports = { loadConfig, validateJwtSecret, parseDuration, ConfigError };
