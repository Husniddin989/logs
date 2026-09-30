const { escapeHtml } = require('./telegram');

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
  restartWarn: 3
};

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

// Turns one snapshot into a flat list of checks:
// { key, level, scope, title, detail }
function evaluate(snapshot, thresholds = DEFAULT_THRESHOLDS) {
  const checks = [];
  const host = snapshot.host;

  if (host) {
    if (host.cpu?.percent !== null && host.cpu?.percent !== undefined) {
      checks.push({
        key: 'server.cpu',
        scope: 'server',
        level: levelFor(host.cpu.percent, thresholds.cpuWarn, thresholds.cpuCritical),
        title: 'Server CPU',
        detail: `CPU: ${formatPercent(host.cpu.percent)} (${host.cpu.cores} core)`
      });
    }
    if (host.memory) {
      checks.push({
        key: 'server.memory',
        scope: 'server',
        level: levelFor(host.memory.percent, thresholds.memWarn, thresholds.memCritical),
        title: 'Server RAM',
        detail: `RAM: ${formatPercent(host.memory.percent)} (${formatBytes(host.memory.used)} / ${formatBytes(host.memory.total)})`
      });
    }
    if (host.disk) {
      checks.push({
        key: 'server.disk',
        scope: 'server',
        level: levelFor(host.disk.percent, thresholds.diskWarn, thresholds.diskCritical),
        title: 'Server disk',
        detail: `Disk: ${formatPercent(host.disk.percent)} (${formatBytes(host.disk.used)} / ${formatBytes(host.disk.total)}, bo‘sh: ${formatBytes(host.disk.available)})`
      });
    }
  }

  if (snapshot.dockerAvailable !== undefined) {
    checks.push({
      key: 'server.docker',
      scope: 'server',
      level: snapshot.dockerAvailable ? 'ok' : 'critical',
      title: 'Docker',
      detail: snapshot.dockerAvailable ? 'Docker API javob beryapti' : 'Docker API javob bermayapti — containerlarni tekshirib bo‘lmadi'
    });
  }

  for (const container of snapshot.containers || []) {
    const state = containerStateCheck(container, thresholds);
    checks.push({
      key: `container.${container.name}.state`,
      scope: 'container',
      container: container.name,
      level: state.level,
      title: `Container ${container.name}`,
      detail: `${state.summary} — image: ${container.image}`
    });

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

  return checks.filter(check => check.level !== null);
}

function alertMessage({ level, title, detail, previousLevel, hostname }) {
  const icon = LEVEL_ICON[level];
  const label = LEVEL_LABEL[level];
  const head = level === 'ok'
    ? `${icon} <b>${label}</b> — tiklandi: ${escapeHtml(title)}`
    : `${icon} <b>${label}</b> — ${escapeHtml(title)}`;
  const lines = [head, escapeHtml(detail)];
  if (previousLevel && previousLevel !== level) {
    lines.push(`<i>holat: ${LEVEL_LABEL[previousLevel]} → ${label}</i>`);
  }
  if (hostname) lines.push(`<i>host: ${escapeHtml(hostname)}</i>`);
  return lines.join('\n');
}

function summaryMessage(snapshot, checks, { hostname } = {}) {
  const host = snapshot.host;
  const worst = checks.reduce(
    (acc, check) => (LEVELS[check.level] > LEVELS[acc] ? check.level : acc),
    'ok'
  );

  const lines = [`${LEVEL_ICON[worst]} <b>Holat hisoboti</b> — ${escapeHtml(hostname || host?.hostname || 'server')}`];

  if (host) {
    lines.push('');
    lines.push('<b>Server</b>');
    lines.push(`CPU: ${formatPercent(host.cpu?.percent)}   RAM: ${formatPercent(host.memory?.percent)}`);
    if (host.disk) {
      lines.push(`Disk: ${formatPercent(host.disk.percent)} (bo‘sh: ${formatBytes(host.disk.available)})`);
    }
    lines.push(`Uptime: ${formatDuration(host.uptimeSeconds)}`);
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
      parts.push(`CPU ${formatPercent(container.cpuPercent)}`);
      if (container.memory?.limit) parts.push(`RAM ${formatPercent(container.memory.percent)}`);
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
  renotifyMs = 30 * 60 * 1000,
  now = () => Date.now(),
  logger = console,
  // key -> { level, title, since, lastNotifiedAt }. Pass the same map when
  // settings change so known problems are not announced again.
  state = new Map()
}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };

  async function run(snapshot) {
    const checks = evaluate(snapshot, limits);
    const time = now();
    const hostname = snapshot.host?.hostname;
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
        state.set(check.key, { level: check.level, title: check.title, since: time, lastNotifiedAt: 0 });
        continue;
      }

      if (changed || needsRepeat) {
        const message = alertMessage({ ...check, previousLevel, hostname });
        sent.push({ key: check.key, level: check.level, message });
        await notifier.send(message);
        state.set(check.key, {
          level: check.level,
          title: check.title,
          since: changed ? time : previous.since,
          lastNotifiedAt: time
        });
      } else {
        state.set(check.key, {
          level: check.level,
          title: check.title,
          since: previous?.since ?? time,
          lastNotifiedAt: previous?.lastNotifiedAt ?? 0
        });
      }
    }

    // Checks that disappeared. CPU/RAM checks vanish whenever a container
    // stops; its state check already reports that, so drop them silently.
    // Only a vanished state check means the container itself was removed.
    for (const [key, previous] of [...state]) {
      if (seen.has(key)) continue;
      // Without Docker the container list is unknown, not empty: keep the
      // previous container states until Docker answers again
      if (snapshot.dockerAvailable === false && key.startsWith('container.')) continue;
      state.delete(key);
      if (key.endsWith('.state') && previous.level !== 'ok') {
        const message = alertMessage({
          level: 'ok',
          title: previous.title,
          detail: 'container o‘chirildi yoki qayta nomlandi — endi kuzatilmaydi',
          previousLevel: previous.level,
          hostname
        });
        sent.push({ key, level: 'ok', message });
        await notifier.send(message);
      }
    }

    return { checks, sent };
  }

  async function sendSummary(snapshot) {
    const checks = evaluate(snapshot, limits);
    const message = summaryMessage(snapshot, checks, { hostname: snapshot.host?.hostname });
    await notifier.send(message);
    return message;
  }

  return { run, sendSummary, evaluate: snapshot => evaluate(snapshot, limits), thresholds: limits, logger };
}

module.exports = {
  createAlerter,
  evaluate,
  alertMessage,
  summaryMessage,
  containerStateCheck,
  formatBytes,
  formatDuration,
  levelFor,
  DEFAULT_THRESHOLDS,
  LEVELS
};
