const os = require('os');
const { createContainerFilter } = require('./containerFilter');

const ACTIONS = ['start', 'stop', 'restart', 'remove'];
const PROTECTED_LABEL = 'docker-log-viewer.protected';
// Seconds Docker waits for a graceful stop before SIGKILL
const STOP_TIMEOUT_SECONDS = 10;

// Inside a container the hostname is the start of its own ID (unless the
// hostname was set explicitly), which is how the backend recognises itself
function ownContainerIdPrefix(hostname = os.hostname()) {
  return /^[0-9a-f]{12,64}$/.test(hostname) ? hostname : null;
}

class ActionError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Start / stop / restart / remove of containers for admins. Decides what is
// allowed (protected containers, remove only when stopped, one action per
// container at a time, a per-admin rate limit) and performs it on the
// container's full ID.
function createContainerActions({
  docker,
  enabled = false,
  // Names or patterns (preview-*) that can never be touched
  protectedContainers = [],
  selfIdPrefix = ownContainerIdPrefix(),
  maxPerMinute = 20,
  now = () => Date.now()
}) {
  const isListedProtected = createContainerFilter({ ignoreContainers: protectedContainers, ignoreCiRunners: false });
  const inFlight = new Set();
  const recent = new Map(); // user id -> timestamps of recent actions

  // Why a container may not be touched at all, or null
  function protectionOf(info) {
    const name = (info.Name || '').replace(/^\//, '');
    if (selfIdPrefix && info.Id.startsWith(selfIdPrefix)) return 'the log viewer itself';
    if (info.Config?.Labels?.[PROTECTED_LABEL] === 'true') return `label ${PROTECTED_LABEL}`;
    if (isListedProtected({ name })) return 'CONTAINER_ACTIONS_PROTECTED';
    return null;
  }

  function takeRateSlot(userId) {
    const time = now();
    const kept = (recent.get(userId) || []).filter(at => time - at < 60 * 1000);
    if (kept.length >= maxPerMinute) {
      recent.set(userId, kept);
      return false;
    }
    kept.push(time);
    recent.set(userId, kept);
    return true;
  }

  // Checks everything that can be checked before acting. `beforeRun` runs
  // right before the Docker call (the caller re-checks the admin there).
  // Returns { changed } - false when Docker says it was already in that state.
  async function perform({ userId, containerId, action, confirmName, beforeRun = () => {} }) {
    if (!enabled) throw new ActionError(403, 'Container boshqaruvi o‘chirilgan (CONTAINER_ACTIONS_ENABLED)', 'disabled');
    if (!ACTIONS.includes(action)) throw new ActionError(400, `Noma’lum amal: ${action}`, 'bad_action');

    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const name = (info.Name || '').replace(/^\//, '');

    const protection = protectionOf(info);
    if (protection) {
      throw new ActionError(403, `Bu container himoyalangan (${protection})`, 'protected');
    }
    if (action === 'remove') {
      if (info.State?.Running || info.State?.Restarting) {
        throw new ActionError(409, 'Ishlab turgan containerni o‘chirib bo‘lmaydi — avval to‘xtating', 'running');
      }
      if (confirmName !== name) {
        throw new ActionError(400, 'O‘chirishni tasdiqlash uchun container nomini aynan yozing', 'not_confirmed');
      }
    }
    if (inFlight.has(info.Id)) {
      throw new ActionError(409, 'Bu container ustida boshqa amal bajarilmoqda', 'busy');
    }
    if (!takeRateSlot(userId)) {
      throw new ActionError(429, 'Juda ko‘p amal — bir daqiqadan keyin urinib ko‘ring', 'rate_limited');
    }

    inFlight.add(info.Id);
    try {
      await beforeRun();
      const target = docker.getContainer(info.Id);
      if (action === 'start') await target.start();
      else if (action === 'stop') await target.stop({ t: STOP_TIMEOUT_SECONDS });
      else if (action === 'restart') await target.restart({ t: STOP_TIMEOUT_SECONDS });
      // Named volumes stay: only the container itself is removed
      else await target.remove({ v: false, force: false });
      return { changed: true, container: { id: info.Id, name } };
    } catch (error) {
      if (error instanceof ActionError) throw error;
      // 304: already started / already stopped
      if (error.statusCode === 304) return { changed: false, container: { id: info.Id, name } };
      const detail = error.json?.message || error.reason || error.message;
      throw new ActionError(502, `Docker amalni bajarmadi: ${String(detail).slice(0, 200)}`, 'docker_error');
    } finally {
      inFlight.delete(info.Id);
    }
  }

  return { enabled, perform, protectionOf, actions: ACTIONS };
}

module.exports = { createContainerActions, ActionError, ownContainerIdPrefix, ACTIONS, PROTECTED_LABEL };
