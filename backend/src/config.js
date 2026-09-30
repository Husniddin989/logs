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

function parsePercent(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    throw new ConfigError(`${name} must be a percentage between 1 and 100`);
  }
  return number;
}

function parseList(value) {
  return (value || '').split(',').map(item => item.trim()).filter(Boolean);
}

// Telegram alerting is off unless both TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are set. Setting only one of them is a mistake worth
// failing loudly on rather than silently sending nothing.
function loadAlertConfig(env) {
  const botToken = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_CHAT_ID || '';

  if (Boolean(botToken) !== Boolean(chatId)) {
    throw new ConfigError('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable alerts (or neither)');
  }
  if (botToken && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN does not look like a bot token (expected 123456:ABC...)');
  }

  // Optional self-hosted Bot API server (https://github.com/tdlib/telegram-bot-api)
  const apiBase = (env.TELEGRAM_API_BASE || '').replace(/\/+$/, '') || undefined;
  if (apiBase && !/^https?:\/\/[^\s/]+/.test(apiBase)) {
    throw new ConfigError('TELEGRAM_API_BASE must be an http(s) URL');
  }

  const enabled = Boolean(botToken) && env.ALERT_ENABLED !== 'false';

  const thresholds = {
    cpuWarn: parsePercent(env.ALERT_CPU_WARN, 80, 'ALERT_CPU_WARN'),
    cpuCritical: parsePercent(env.ALERT_CPU_CRITICAL, 95, 'ALERT_CPU_CRITICAL'),
    memWarn: parsePercent(env.ALERT_MEM_WARN, 80, 'ALERT_MEM_WARN'),
    memCritical: parsePercent(env.ALERT_MEM_CRITICAL, 95, 'ALERT_MEM_CRITICAL'),
    diskWarn: parsePercent(env.ALERT_DISK_WARN, 80, 'ALERT_DISK_WARN'),
    diskCritical: parsePercent(env.ALERT_DISK_CRITICAL, 90, 'ALERT_DISK_CRITICAL'),
    containerCpuWarn: parsePercent(env.ALERT_CONTAINER_CPU_WARN, 85, 'ALERT_CONTAINER_CPU_WARN'),
    containerCpuCritical: parsePercent(env.ALERT_CONTAINER_CPU_CRITICAL, 95, 'ALERT_CONTAINER_CPU_CRITICAL'),
    containerMemWarn: parsePercent(env.ALERT_CONTAINER_MEM_WARN, 85, 'ALERT_CONTAINER_MEM_WARN'),
    containerMemCritical: parsePercent(env.ALERT_CONTAINER_MEM_CRITICAL, 95, 'ALERT_CONTAINER_MEM_CRITICAL'),
    restartWarn: Number(env.ALERT_RESTART_WARN) > 0 ? Number(env.ALERT_RESTART_WARN) : 3
  };

  for (const metric of ['cpu', 'mem', 'disk', 'containerCpu', 'containerMem']) {
    if (thresholds[`${metric}Warn`] >= thresholds[`${metric}Critical`]) {
      throw new ConfigError(`Alert threshold for ${metric}: warn must be lower than critical`);
    }
  }

  return {
    enabled,
    telegram: { botToken, chatId, apiBase },
    intervalSeconds: parseDuration(env.ALERT_INTERVAL || '60s', 'ALERT_INTERVAL'),
    renotifySeconds: parseDuration(env.ALERT_RENOTIFY || '30m', 'ALERT_RENOTIFY'),
    // "0" turns the periodic status report off
    summarySeconds: env.ALERT_SUMMARY_INTERVAL === '0' ? 0 : parseDuration(env.ALERT_SUMMARY_INTERVAL || '24h', 'ALERT_SUMMARY_INTERVAL'),
    diskPath: env.ALERT_DISK_PATH || '/',
    hostname: (env.ALERT_HOSTNAME || '').trim() || null,
    ignoreContainers: parseList(env.ALERT_IGNORE_CONTAINERS),
    thresholds
  };
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
    },
    alerts: loadAlertConfig(env)
  };
}

module.exports = { loadConfig, loadAlertConfig, validateJwtSecret, parseDuration, ConfigError };
