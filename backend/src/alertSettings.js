const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseDuration } = require('./config');
const { isValidContainerRef } = require('./access');
const {
  DEFAULT_THRESHOLDS,
  DEFAULT_CHECKS,
  DEFAULT_TEMPLATE,
  DEFAULT_TIMEZONE,
  validateTemplate,
  isValidTimeZone
} = require('./alerting');
const { DEFAULT_PORTS } = require('./services');
const { isPattern, isValidPattern } = require('./containerFilter');

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
// Numeric chat/group/channel id, or a public channel username
const CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

const PERCENT_KEYS = [
  'cpuWarn', 'cpuCritical', 'memWarn', 'memCritical', 'diskWarn', 'diskCritical',
  'containerCpuWarn', 'containerCpuCritical', 'containerMemWarn', 'containerMemCritical',
  'serviceWarn', 'serviceCritical'
];
const THRESHOLD_PAIRS = [
  ['cpuWarn', 'cpuCritical', 'Server CPU'],
  ['memWarn', 'memCritical', 'Server RAM'],
  ['diskWarn', 'diskCritical', 'Server disk'],
  ['containerCpuWarn', 'containerCpuCritical', 'Container CPU'],
  ['containerMemWarn', 'containerMemCritical', 'Container RAM'],
  ['serviceWarn', 'serviceCritical', 'Postgres / Redis']
];

const MAX_SERVICES = 20;
const SERVICE_TYPES = Object.keys(DEFAULT_PORTS);
// Hostname, IPv4 or IPv6 address
const HOST_PATTERN = /^[A-Za-z0-9._:[\]-]{1,253}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Initial values come from the environment until an admin saves settings in
// the UI; from then on the saved file is the source of truth.
function defaultsFromConfig(alerts) {
  return {
    enabled: alerts.enabled,
    botToken: alerts.telegram.botToken || '',
    chatId: alerts.telegram.chatId || '',
    hostname: alerts.hostname || '',
    serverIp: alerts.serverIp || '',
    timezone: alerts.timezone || DEFAULT_TIMEZONE,
    messageTemplate: DEFAULT_TEMPLATE,
    intervalSeconds: alerts.intervalSeconds,
    renotifySeconds: alerts.renotifySeconds,
    summarySeconds: alerts.summarySeconds,
    ignoreContainers: alerts.ignoreContainers,
    ignoreCiRunners: alerts.ignoreCiRunners !== false,
    checks: { ...DEFAULT_CHECKS, containerResources: Boolean(alerts.containerResources) },
    // Postgres / Redis servers to probe: { id, type, name, host, port, user,
    // password, database, ssl, enabled }
    services: [],
    thresholds: { ...DEFAULT_THRESHOLDS, ...alerts.thresholds }
  };
}

function createAlertSettingsStore(file, defaults) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { settings: structuredClone(defaults), source: 'env' };
      throw error;
    }
    const saved = JSON.parse(raw);
    // Fields added in later versions fall back to the defaults
    return {
      settings: {
        ...structuredClone(defaults),
        ...saved,
        checks: { ...defaults.checks, ...(saved.checks || {}) },
        thresholds: { ...defaults.thresholds, ...(saved.thresholds || {}) }
      },
      source: 'saved'
    };
  }

  // The file holds the bot token: write atomically, readable by owner only
  function save(settings) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return { file, load, save };
}

// The UI never receives the token itself - only whether one is set and a hint
// (bot id + last 4 characters) to recognise which bot it is.
function tokenHint(token) {
  if (!token) return '';
  const [botId, secret = ''] = token.split(':');
  return `${botId}:…${secret.slice(-4)}`;
}

// Database passwords are never sent to the browser either
function publicSettings(settings) {
  const { botToken, ...rest } = settings;
  return {
    ...rest,
    services: (settings.services || []).map(({ password, ...service }) => ({ ...service, hasPassword: Boolean(password) })),
    hasBotToken: Boolean(botToken),
    botTokenHint: tokenHint(botToken)
  };
}

function isSendable(settings) {
  return Boolean(settings.enabled && settings.botToken && settings.chatId);
}

function validateBotToken(token) {
  return BOT_TOKEN_PATTERN.test(token) ? null : 'Bot token noto‘g‘ri ko‘rinishda (kutilgan: 123456789:ABC...)';
}

function validateChatId(chatId) {
  return CHAT_ID_PATTERN.test(chatId) ? null : 'Chat ID raqam (masalan -1001234567890) yoki @kanal_nomi bo‘lishi kerak';
}

function durationSeconds(value, name, { min, max, allowZero = false }) {
  if (allowZero && (value === 0 || value === '0')) return 0;
  let seconds;
  try {
    seconds = typeof value === 'number' ? value : parseDuration(value, name);
  } catch {
    throw new Error(`${name}: 90, 60s, 15m, 12h yoki 1d ko‘rinishida kiriting`);
  }
  if (!Number.isInteger(seconds) || seconds < min || seconds > max) {
    throw new Error(`${name}: ${min} soniyadan ${max} soniyagacha bo‘lishi kerak`);
  }
  return seconds;
}

function shortText(value, label, max, { required = false } = {}) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw new Error(`${label} kiritilmagan`);
  if (text.length > max || CONTROL_CHARS.test(text)) throw new Error(`${label} ${max} belgidan oshmasligi kerak`);
  return text;
}

// One Postgres / Redis entry from the UI. An empty password keeps the one
// saved for the same id, like the bot token.
function normalizeService(input, saved = []) {
  if (!input || typeof input !== 'object') throw new Error('Noto‘g‘ri servis');
  const type = String(input.type || '');
  if (!SERVICE_TYPES.includes(type)) throw new Error(`Servis turi ${SERVICE_TYPES.join(' yoki ')} bo‘lishi kerak`);

  const existing = saved.find(service => service.id === input.id);
  const id = existing ? existing.id : crypto.randomBytes(6).toString('hex');

  const name = shortText(input.name, 'Servis nomi', 50) || type;
  const host = shortText(input.host, `${name}: host`, 253, { required: true });
  if (!HOST_PATTERN.test(host)) throw new Error(`${name}: host noto‘g‘ri (masalan postgres, 10.0.0.5)`);

  const port = input.port === undefined || input.port === '' ? DEFAULT_PORTS[type] : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name}: port 1-65535 bo‘lishi kerak`);

  let password = existing?.password || '';
  if (input.clearPassword === true) password = '';
  else if (typeof input.password === 'string' && input.password !== '') {
    if (input.password.length > 500) throw new Error(`${name}: parol juda uzun`);
    password = input.password;
  }

  return {
    id,
    type,
    name,
    host,
    port,
    user: shortText(input.user, `${name}: foydalanuvchi`, 100),
    password,
    database: type === 'postgres' ? shortText(input.database, `${name}: database`, 100) : '',
    ssl: type === 'postgres' && input.ssl === true,
    enabled: input.enabled !== false
  };
}

// Applies a partial update from the admin UI to the current settings.
// Returns { settings, changes } or { error }. `changes` lists changed field
// names for the audit log; the token appears only as "botToken".
function applySettingsUpdate(current, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid settings payload' };
  }

  const next = structuredClone(current);

  try {
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false');
      next.enabled = body.enabled;
    }

    if (body.clearBotToken === true) {
      next.botToken = '';
    } else if (body.botToken !== undefined && body.botToken !== '') {
      if (typeof body.botToken !== 'string') throw new Error('botToken must be a string');
      const token = body.botToken.trim();
      const problem = validateBotToken(token);
      if (problem) throw new Error(problem);
      next.botToken = token;
    }

    if (body.chatId !== undefined) {
      const chatId = String(body.chatId).trim();
      if (chatId) {
        const problem = validateChatId(chatId);
        if (problem) throw new Error(problem);
      }
      next.chatId = chatId;
    }

    if (body.hostname !== undefined) {
      const hostname = String(body.hostname).trim();
      if (hostname.length > 100 || /[\u0000-\u001f\u007f]/.test(hostname)) {
        throw new Error('Server nomi 100 belgidan oshmasligi kerak');
      }
      next.hostname = hostname;
    }

    if (body.serverIp !== undefined) {
      next.serverIp = shortText(body.serverIp, 'Server IP', 100);
    }

    if (body.timezone !== undefined) {
      const timezone = String(body.timezone).trim() || DEFAULT_TIMEZONE;
      if (!isValidTimeZone(timezone)) throw new Error('Vaqt zonasi noto‘g‘ri (masalan Asia/Tashkent)');
      next.timezone = timezone;
    }

    if (body.messageTemplate !== undefined) {
      const template = String(body.messageTemplate).replace(/\r\n/g, '\n');
      const problem = validateTemplate(template);
      if (problem) throw new Error(problem);
      next.messageTemplate = template;
    }

    if (body.checks !== undefined) {
      if (!body.checks || typeof body.checks !== 'object') throw new Error('checks must be an object');
      for (const key of Object.keys(DEFAULT_CHECKS)) {
        if (body.checks[key] === undefined) continue;
        if (typeof body.checks[key] !== 'boolean') throw new Error(`checks.${key} must be true or false`);
        next.checks[key] = body.checks[key];
      }
    }

    if (body.services !== undefined) {
      if (!Array.isArray(body.services) || body.services.length > MAX_SERVICES) {
        throw new Error(`Postgres/Redis ro‘yxati ko‘pi bilan ${MAX_SERVICES} ta bo‘lishi mumkin`);
      }
      // Each saved entry (and its password) can be claimed by one row only
      let unclaimed = [...(current.services || [])];
      next.services = body.services.map(service => {
        const normalized = normalizeService(service, unclaimed);
        unclaimed = unclaimed.filter(saved => saved.id !== normalized.id);
        return normalized;
      });
    }

    if (body.intervalSeconds !== undefined) {
      next.intervalSeconds = durationSeconds(body.intervalSeconds, 'Tekshiruv oralig‘i', { min: 15, max: 3600 });
    }
    if (body.renotifySeconds !== undefined) {
      next.renotifySeconds = durationSeconds(body.renotifySeconds, 'Qayta eslatish', { min: 60, max: 7 * 86400 });
    }
    if (body.summarySeconds !== undefined) {
      next.summarySeconds = durationSeconds(body.summarySeconds, 'Holat hisoboti', { min: 300, max: 30 * 86400, allowZero: true });
    }

    if (body.ignoreContainers !== undefined) {
      if (!Array.isArray(body.ignoreContainers) || body.ignoreContainers.length > 200) {
        throw new Error('ignoreContainers must be a list of container names');
      }
      const names = [...new Set(body.ignoreContainers.map(name => String(name).trim()).filter(Boolean))];
      // Exact names, or patterns with * such as runner-*
      const bad = names.find(name => (isPattern(name) ? !isValidPattern(name) : !isValidContainerRef(name)));
      if (bad) throw new Error(`Noto‘g‘ri container nomi: ${bad}`);
      next.ignoreContainers = names;
    }

    if (body.ignoreCiRunners !== undefined) {
      if (typeof body.ignoreCiRunners !== 'boolean') throw new Error('ignoreCiRunners must be true or false');
      next.ignoreCiRunners = body.ignoreCiRunners;
    }

    if (body.thresholds !== undefined) {
      if (!body.thresholds || typeof body.thresholds !== 'object') throw new Error('thresholds must be an object');
      for (const key of PERCENT_KEYS) {
        if (body.thresholds[key] === undefined) continue;
        const value = Number(body.thresholds[key]);
        if (!Number.isFinite(value) || value <= 0 || value > 100) {
          throw new Error(`${key}: 1 dan 100 gacha foiz bo‘lishi kerak`);
        }
        next.thresholds[key] = value;
      }
      if (body.thresholds.restartWarn !== undefined) {
        const value = Number(body.thresholds.restartWarn);
        if (!Number.isInteger(value) || value < 1 || value > 1000) {
          throw new Error('restartWarn: 1 dan 1000 gacha butun son bo‘lishi kerak');
        }
        next.thresholds.restartWarn = value;
      }
      for (const [warn, critical, label] of THRESHOLD_PAIRS) {
        if (next.thresholds[warn] >= next.thresholds[critical]) {
          throw new Error(`${label}: WARN chegarasi CRITICAL dan kichik bo‘lishi kerak`);
        }
      }
    }

    if (next.enabled && (!next.botToken || !next.chatId)) {
      throw new Error('Alertlarni yoqish uchun bot token va chat ID kerak');
    }
  } catch (error) {
    return { error: error.message };
  }

  const changes = Object.keys(next).filter(key => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  return { settings: next, changes };
}

module.exports = {
  createAlertSettingsStore,
  defaultsFromConfig,
  applySettingsUpdate,
  publicSettings,
  isSendable,
  tokenHint,
  validateBotToken,
  validateChatId,
  normalizeService
};
