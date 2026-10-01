const { escapeHtml } = require('./telegram');
const { SERVICE_LABELS } = require('./services');

const LEVELS = { ok: 0, warn: 1, critical: 2 };
const LEVEL_ICON = { ok: '🟢', warn: '🟡', critical: '🔴' };
const LEVEL_LABEL = { ok: 'OK', warn: 'WARN', critical: 'CRITICAL' };

const DEFAULT_THRESHOLDS = {
  cpuWarn: 80,
  cpuCritical: 95,
  memWarn: 80,
  memCritical: 95,
  diskWarn: 80,
  diskCritical: 90,
  containerCpuWarn: 85,
  containerCpuCritical: 95,
  containerMemWarn: 85,
  containerMemCritical: 95,
  restartWarn: 3,
  // Postgres connections of max_connections, Redis memory of maxmemory
  serviceWarn: 80,
  serviceCritical: 95
};

// Which groups of checks run. Container CPU/RAM is off by default: busy app
// containers cross any fixed limit all the time and drown the real alerts.
const DEFAULT_CHECKS = {
  serverCpu: true,
  serverMemory: true,
  serverDisk: true,
  docker: true,
  containerState: true,
  containerResources: false
};

// Every alert is rendered from this template (editable in the UI).
// {placeholders} are filled in and HTML-escaped; <b>, <i>, <u>, <s> and
// <code> typed in the template are kept as Telegram formatting.
const DEFAULT_TEMPLATE = [
  '{icon} <b>{level}</b> — {title}',
  'server name: {server}',
  'ip: {ip}',
  'cpu: {cpu}',
  'ram: {ram}',
  'joy: {disk}',
  'status: {status}',
  'timedown: {timedown}',
  'timeup: {timeup}'
].join('\n');

const TEMPLATE_PLACEHOLDERS = {
  icon: '🟢 / 🟡 / 🔴',
  level: 'OK / WARN / CRITICAL',
  title: 'nima haqida (Server RAM, Container app, Postgres main)',
  server: 'server nomi',
  ip: 'server IP manzili',
  cpu: 'server CPU',
  ram: 'server RAM (ishlatilgan / jami)',
  disk: 'disk joyi (ishlatilgan / jami, bo‘sh)',
  status: 'muammo tafsiloti yoki "tiklandi"',
  timedown: 'muammo boshlangan vaqt',
  timeup: 'tiklangan vaqt (muammo davom etsa —)',
  duration: 'muammo davomiyligi',
  change: 'holat o‘zgarishi (OK → CRITICAL)',
  detail: 'faqat tafsilot (tiklandi so‘zisiz)'
};
const ALLOWED_TAGS = ['b', 'i', 'u', 's', 'code'];
const MAX_TEMPLATE_LENGTH = 2000;
const DEFAULT_TIMEZONE = 'Asia/Tashkent';

function levelFor(value, warn, critical) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= critical) return 'critical';
  if (value >= warn) return 'warn';
  return 'ok';
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatPercent(value) {
  return value === null || value === undefined ? 'n/a' : `${value.toFixed(1)}%`;
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return 'n/a';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Downtime length: "45s", "5m 10s", "2h 3m", "1d 4h"
function formatElapsed(ms) {
  if (ms === null || ms === undefined || ms < 0) return 'n/a';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return formatDuration(seconds);
}

// "2026-10-01 14:05:32" in the configured time zone
function formatTime(ms, timeZone = DEFAULT_TIMEZONE) {
  if (!ms) return '—';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ms));
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
  const part = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Escapes the template, then restores the allowed formatting tags and fills
// in the (escaped) values. Unknown {names} are left as typed.
function renderTemplate(template, values) {
  const tags = ALLOWED_TAGS.join('|');
  return escapeHtml(template)
    .replace(new RegExp(`&lt;(/?)(${tags})&gt;`, 'g'), '<$1$2>')
    .replace(/\{(\w+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(values, key) ? escapeHtml(values[key] ?? '') : match
    ));
}

// Returns an error message, or null when the template is usable. Telegram
// rejects a message with unbalanced tags, which would silently lose alerts.
function validateTemplate(template) {
  if (typeof template !== 'string' || !template.trim()) return 'Xabar shabloni bo‘sh bo‘lmasligi kerak';
  if (template.length > MAX_TEMPLATE_LENGTH) return `Xabar shabloni ${MAX_TEMPLATE_LENGTH} belgidan oshmasligi kerak`;

  const unknown = [...template.matchAll(/\{(\w+)\}/g)]
    .map(match => match[1])
    .find(name => !Object.prototype.hasOwnProperty.call(TEMPLATE_PLACEHOLDERS, name));
  if (unknown) return `Noma’lum o‘zgaruvchi: {${unknown}}`;

  const stack = [];
  for (const [, closing, tag] of template.matchAll(new RegExp(`<(/?)(${ALLOWED_TAGS.join('|')})>`, 'g'))) {
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) return `Shablonda <${tag}> teglari juft emas`;
  }
  if (stack.length) return `Shablonda <${stack.at(-1)}> yopilmagan`;
  return null;
}

// Docker reports "0001-01-01T00:00:00Z" for times that never happened
function dockerTime(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Why a container is not simply "running". Returns { level, summary }.
function containerStateCheck(container, thresholds) {
  const { state, health, exitCode, oomKilled, restartCount } = container;

  if (state === 'running') {
    if (health === 'unhealthy') {
      return { level: 'critical', summary: 'ishlayapti, lekin healthcheck unhealthy' };
    }
    if (health === 'starting') {
      return { level: 'ok', summary: 'ishga tushmoqda (healthcheck starting)' };
    }
    if (restartCount >= thresholds.restartWarn) {
      return { level: 'warn', summary: `ishlayapti, lekin ${restartCount} marta qayta ishga tushgan` };
    }
    return { level: 'ok', summary: 'ishlayapti' };
  }

  if (state === 'restarting') {
    return { level: 'critical', summary: `qayta ishga tushmoqda (restart: ${restartCount})` };
  }
  if (state === 'paused') {
    return { level: 'warn', summary: 'to‘xtatib qo‘yilgan (paused)' };
  }
  if (state === 'created') {
    return { level: 'warn', summary: 'yaratilgan, lekin ishga tushmagan' };
  }
  if (oomKilled) {
    return { level: 'critical', summary: 'xotira tugab o‘chgan (OOM killed)' };
  }
  if (state === 'dead') {
    return { level: 'critical', summary: 'dead holatida' };
  }
  if (state === 'exited') {
    return exitCode === 0
      ? { level: 'warn', summary: 'to‘xtagan (exit code 0)' }
      : { level: 'critical', summary: `xato bilan to‘xtagan (exit code ${exitCode})` };
  }
  return { level: 'warn', summary: `holati: ${state}` };
}

function serviceCheck(service, thresholds) {
  const base = {
    key: `service.${service.id}`,
    scope: 'service',
    service: service.id,
    title: `${SERVICE_LABELS[service.type] || service.type} ${service.name}`
  };
  if (!service.ok) {
    return { ...base, level: 'critical', detail: `javob bermayapti (${service.target}): ${service.error}` };
  }

  const latency = `javob: ${service.latencyMs} ms`;
  if (service.type === 'postgres') {
    const usage = service.maxConnections > 0 ? (service.connections / service.maxConnections) * 100 : null;
    return {
      ...base,
      level: levelFor(usage, thresholds.serviceWarn, thresholds.serviceCritical) || 'ok',
      detail: `ishlayapti — ulanishlar: ${service.connections}/${service.maxConnections} (${formatPercent(usage)}), hajm: ${formatBytes(service.sizeBytes)}, ${latency}`
    };
  }

  // Without maxmemory Redis grows until the server runs out; only the
  // server RAM check can say something then
  const usage = service.maxMemory > 0 ? (service.usedMemory / service.maxMemory) * 100 : null;
  const memory = usage === null
    ? formatBytes(service.usedMemory)
    : `${formatBytes(service.usedMemory)} / ${formatBytes(service.maxMemory)} (${formatPercent(usage)})`;
  return {
    ...base,
    level: levelFor(usage, thresholds.serviceWarn, thresholds.serviceCritical) || 'ok',
    detail: `ishlayapti — xotira: ${memory}, clientlar: ${service.clients}, ${latency}`
  };
}

// Turns one snapshot into a flat list of checks:
// { key, level, scope, title, detail, downAt?, upAt? }
// downAt / upAt are when the problem really started / ended, where Docker
// knows it (a container's FinishedAt / StartedAt)
function evaluate(snapshot, thresholds = DEFAULT_THRESHOLDS, enabledChecks = DEFAULT_CHECKS) {
  const enabled = { ...DEFAULT_CHECKS, ...enabledChecks };
  const checks = [];
  const host = snapshot.host;

  if (host) {
    if (enabled.serverCpu && host.cpu?.percent !== null && host.cpu?.percent !== undefined) {
      checks.push({
        key: 'server.cpu',
        scope: 'server',
        level: levelFor(host.cpu.percent, thresholds.cpuWarn, thresholds.cpuCritical),
        title: 'Server CPU',
        detail: `CPU: ${formatPercent(host.cpu.percent)} (${host.cpu.cores} core)`
      });
    }
    if (enabled.serverMemory && host.memory) {
      checks.push({
        key: 'server.memory',
        scope: 'server',
        level: levelFor(host.memory.percent, thresholds.memWarn, thresholds.memCritical),
        title: 'Server RAM',
        detail: `RAM: ${formatPercent(host.memory.percent)} (${formatBytes(host.memory.used)} / ${formatBytes(host.memory.total)})`
      });
    }
    if (enabled.serverDisk && host.disk) {
      checks.push({
        key: 'server.disk',
        scope: 'server',
        level: levelFor(host.disk.percent, thresholds.diskWarn, thresholds.diskCritical),
        title: 'Server disk',
        detail: `Disk: ${formatPercent(host.disk.percent)} (${formatBytes(host.disk.used)} / ${formatBytes(host.disk.total)}, bo‘sh: ${formatBytes(host.disk.available)})`
      });
    }
  }

  if (enabled.docker && snapshot.dockerAvailable !== undefined) {
    checks.push({
      key: 'server.docker',
      scope: 'server',
      level: snapshot.dockerAvailable ? 'ok' : 'critical',
      title: 'Docker',
      detail: snapshot.dockerAvailable ? 'Docker API javob beryapti' : 'Docker API javob bermayapti — containerlarni tekshirib bo‘lmadi'
    });
  }

  for (const container of snapshot.containers || []) {
    if (enabled.containerState) {
      const state = containerStateCheck(container, thresholds);
      const running = container.state === 'running';
      checks.push({
        key: `container.${container.name}.state`,
        scope: 'container',
        container: container.name,
        level: state.level,
        title: `Container ${container.name}`,
        detail: `${state.summary} — image: ${container.image}`,
        downAt: running ? null : dockerTime(container.finishedAt),
        upAt: running ? dockerTime(container.startedAt) : null
      });
    }

    if (!enabled.containerResources) continue;
    // Resource checks only make sense while the container runs
    if (container.state === 'running' && container.cpuPercent !== null) {
      checks.push({
        key: `container.${container.name}.cpu`,
        scope: 'container',
        container: container.name,
        level: levelFor(container.cpuPercent, thresholds.containerCpuWarn, thresholds.containerCpuCritical),
        title: `Container ${container.name} CPU`,
        detail: `CPU: ${formatPercent(container.cpuPercent)}`
      });
    }
    if (container.state === 'running' && container.memory?.limit) {
      checks.push({
        key: `container.${container.name}.memory`,
        scope: 'container',
        container: container.name,
        level: levelFor(container.memory.percent, thresholds.containerMemWarn, thresholds.containerMemCritical),
        title: `Container ${container.name} RAM`,
        detail: `RAM: ${formatPercent(container.memory.percent)} (${formatBytes(container.memory.used)} / ${formatBytes(container.memory.limit)})`
      });
    }
  }

  for (const service of snapshot.services || []) {
    checks.push(serviceCheck(service, thresholds));
  }

  return checks.filter(check => check.level !== null);
}

// The values a template can use, for one check at one moment.
// context: { host, hostname, serverIp, timeZone, now }
function templateValues({ level, title, detail, previousLevel, downAt = null, upAt = null, status }, context = {}) {
  const { host, timeZone, now = Date.now() } = context;
  const recovered = level === 'ok';
  const end = recovered ? (upAt ?? now) : now;
  return {
    icon: LEVEL_ICON[level],
    level: LEVEL_LABEL[level],
    title,
    server: context.hostname || host?.hostname || 'server',
    ip: context.serverIp || '—',
    cpu: formatPercent(host?.cpu?.percent),
    ram: host?.memory
      ? `${formatPercent(host.memory.percent)} (${formatBytes(host.memory.used)} / ${formatBytes(host.memory.total)})`
      : 'n/a',
    disk: host?.disk
      ? `${formatPercent(host.disk.percent)} (${formatBytes(host.disk.used)} / ${formatBytes(host.disk.total)}, bo‘sh: ${formatBytes(host.disk.available)})`
      : 'n/a',
    status: status ?? (recovered ? `tiklandi: ${detail}` : detail),
    detail,
    timedown: formatTime(downAt, timeZone),
    timeup: recovered ? formatTime(end, timeZone) : '—',
    duration: downAt ? formatElapsed(end - downAt) : 'n/a',
    change: previousLevel && previousLevel !== level ? `${LEVEL_LABEL[previousLevel]} → ${LEVEL_LABEL[level]}` : LEVEL_LABEL[level]
  };
}

function alertMessage(check, context = {}) {
  return renderTemplate(context.template || DEFAULT_TEMPLATE, templateValues(check, context));
}

// Example messages for the UI preview and the test message
function sampleMessages(context = {}) {
  const now = context.now ?? Date.now();
  const down = {
    level: 'critical',
    previousLevel: 'ok',
    title: 'Container example-app',
    detail: 'xato bilan to‘xtagan (exit code 1) — image: example-app:latest',
    downAt: now - 5 * 60 * 1000
  };
  const up = { ...down, level: 'ok', previousLevel: 'critical', detail: 'ishlayapti — image: example-app:latest', upAt: now };
  return {
    down: alertMessage(down, { ...context, now }),
    up: alertMessage(up, { ...context, now })
  };
}

function summaryMessage(snapshot, checks, { hostname, serverIp, checks: enabledChecks } = {}) {
  const enabled = { ...DEFAULT_CHECKS, ...enabledChecks };
  const host = snapshot.host;
  const worst = checks.reduce(
    (acc, check) => (LEVELS[check.level] > LEVELS[acc] ? check.level : acc),
    'ok'
  );

  const lines = [`${LEVEL_ICON[worst]} <b>Holat hisoboti</b> — ${escapeHtml(hostname || host?.hostname || 'server')}`];
  if (serverIp) lines.push(`IP: ${escapeHtml(serverIp)}`);

  if (host) {
    lines.push('');
    lines.push('<b>Server</b>');
    lines.push(`CPU: ${formatPercent(host.cpu?.percent)}   RAM: ${formatPercent(host.memory?.percent)}`);
    if (host.disk) {
      lines.push(`Disk: ${formatPercent(host.disk.percent)} (bo‘sh: ${formatBytes(host.disk.available)})`);
    }
    lines.push(`Uptime: ${formatDuration(host.uptimeSeconds)}`);
  }

  const services = checks.filter(check => check.scope === 'service');
  if (services.length) {
    lines.push('');
    lines.push('<b>Postgres / Redis</b>');
    for (const check of services) {
      lines.push(`${LEVEL_ICON[check.level]} <b>${escapeHtml(check.title)}</b> · ${escapeHtml(check.detail)}`);
    }
  }

  const containers = snapshot.containers || [];
  const running = containers.filter(c => c.state === 'running');
  lines.push('');
  lines.push(`<b>Containerlar</b> (${running.length}/${containers.length} ishlayapti)`);

  const levelByContainer = new Map();
  for (const check of checks) {
    if (check.scope !== 'container') continue;
    const current = levelByContainer.get(check.container) || 'ok';
    if (LEVELS[check.level] > LEVELS[current]) levelByContainer.set(check.container, check.level);
  }

  for (const container of containers) {
    const level = levelByContainer.get(container.name) || 'ok';
    const parts = [`${LEVEL_ICON[level]} <b>${escapeHtml(container.name)}</b>`, container.state];
    if (container.state === 'running') {
      if (enabled.containerResources) {
        parts.push(`CPU ${formatPercent(container.cpuPercent)}`);
        if (container.memory?.limit) parts.push(`RAM ${formatPercent(container.memory.percent)}`);
      }
      if (container.health) parts.push(container.health);
    } else if (container.exitCode !== null && container.exitCode !== undefined) {
      parts.push(`exit ${container.exitCode}`);
    }
    lines.push(parts.join(' · '));
  }

  return lines.join('\n');
}

// Decides what actually gets sent. A message goes out when a check changes
// level, and again for a still-failing check once renotifyMs has passed, so a
// lasting problem is repeated without flooding the chat.
function createAlerter({
  notifier,
  thresholds = {},
  checks: enabledChecks = {},
  // { template, serverIp, timeZone } for the alert messages
  message = {},
  renotifyMs = 30 * 60 * 1000,
  now = () => Date.now(),
  logger = console,
  // key -> { level, title, since, lastNotifiedAt, downSince }. Pass the same
  // map when settings change so known problems are not announced again.
  state = new Map()
}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const enabled = { ...DEFAULT_CHECKS, ...enabledChecks };

  async function run(snapshot) {
    const checks = evaluate(snapshot, limits, enabled);
    const time = now();
    const context = { ...message, host: snapshot.host, hostname: snapshot.host?.hostname, now: time };
    const seen = new Set();
    const sent = [];

    for (const check of checks) {
      seen.add(check.key);
      const previous = state.get(check.key);
      const previousLevel = previous?.level;

      const changed = previousLevel !== check.level;
      const needsRepeat = !changed &&
        check.level !== 'ok' &&
        previous &&
        time - previous.lastNotifiedAt >= renotifyMs;

      // The first reading of an already-healthy check is the baseline: record
      // it without announcing anything.
      const isFirstAndOk = !previous && check.level === 'ok';

      if (isFirstAndOk) {
        state.set(check.key, { level: check.level, title: check.title, since: time, lastNotifiedAt: 0, downSince: null });
        continue;
      }

      // When this outage began: kept through WARN -> CRITICAL steps and
      // repeats, cleared on recovery
      let downSince = previous?.downSince ?? (previous && previousLevel !== 'ok' ? previous.since : null);
      if (check.level !== 'ok' && !downSince) {
        downSince = check.downAt && check.downAt <= time ? check.downAt : time;
      }
      const upAt = check.level === 'ok' && check.upAt && check.upAt <= time && (!downSince || check.upAt >= downSince)
        ? check.upAt
        : time;

      if (changed || needsRepeat) {
        const text = alertMessage({ ...check, previousLevel, downAt: downSince, upAt }, context);
        sent.push({ key: check.key, level: check.level, message: text });
        await notifier.send(text);
        state.set(check.key, {
          level: check.level,
          title: check.title,
          since: changed ? time : previous.since,
          lastNotifiedAt: time,
          downSince: check.level === 'ok' ? null : downSince
        });
      } else {
        state.set(check.key, {
          level: check.level,
          title: check.title,
          since: previous?.since ?? time,
          lastNotifiedAt: previous?.lastNotifiedAt ?? 0,
          downSince: check.level === 'ok' ? null : downSince
        });
      }
    }

    // Checks that disappeared. CPU/RAM checks vanish whenever a container
    // stops (or the check is turned off); its state check already reports
    // that, so drop them silently. Only a vanished state check means the
    // container itself was removed.
    for (const [key, previous] of [...state]) {
      if (seen.has(key)) continue;
      // Without Docker the container list is unknown, not empty: keep the
      // previous container states until Docker answers again
      if (snapshot.dockerAvailable === false && key.startsWith('container.')) continue;
      state.delete(key);
      if (enabled.containerState && key.endsWith('.state') && previous.level !== 'ok') {
        const detail = 'container o‘chirildi yoki qayta nomlandi — endi kuzatilmaydi';
        const text = alertMessage({
          level: 'ok',
          title: previous.title,
          detail,
          status: detail,
          previousLevel: previous.level,
          downAt: previous.downSince ?? previous.since,
          upAt: time
        }, context);
        sent.push({ key, level: 'ok', message: text });
        await notifier.send(text);
      }
    }

    return { checks, sent };
  }

  async function sendSummary(snapshot) {
    const checks = evaluate(snapshot, limits, enabled);
    const text = summaryMessage(snapshot, checks, {
      hostname: snapshot.host?.hostname,
      serverIp: message.serverIp,
      checks: enabled
    });
    await notifier.send(text);
    return text;
  }

  return {
    run,
    sendSummary,
    evaluate: snapshot => evaluate(snapshot, limits, enabled),
    thresholds: limits,
    checks: enabled,
    logger
  };
}

module.exports = {
  createAlerter,
  evaluate,
  alertMessage,
  sampleMessages,
  summaryMessage,
  containerStateCheck,
  serviceCheck,
  renderTemplate,
  validateTemplate,
  isValidTimeZone,
  formatBytes,
  formatDuration,
  formatElapsed,
  formatTime,
  levelFor,
  DEFAULT_THRESHOLDS,
  DEFAULT_CHECKS,
  DEFAULT_TEMPLATE,
  DEFAULT_TIMEZONE,
  TEMPLATE_PLACEHOLDERS,
  LEVELS
};
