const { collectContainers } = require('./metrics');
const { probeService } = require('./services');

// Periodically collects a snapshot and hands it to the alerter. One tick at
// a time: if a tick is slow (Docker stats can take seconds), the next one is
// skipped rather than piling up.
function createMonitor({
  docker,
  hostCollector,
  alerter,
  intervalMs = 60 * 1000,
  summaryIntervalMs = 24 * 60 * 60 * 1000,
  warmupMs = 5000,
  // Send the status report right after starting (process start), not when
  // an admin merely changed settings
  announceOnStart = true,
  ignoreContainers = [],
  // Postgres / Redis servers to probe on every tick
  services = [],
  probe = probeService,
  collect = collectContainers,
  logger = console,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout }
}) {
  const ignored = new Set(ignoreContainers);
  let running = false;
  let tickTimer = null;
  let summaryTimer = null;
  let warmupTimer = null;
  let busy = false;

  const probed = services.filter(service => service.enabled !== false);

  async function snapshot() {
    const [host, containers, serviceResults] = await Promise.all([
      hostCollector.collect(),
      collect(docker, { logger }).catch(error => {
        logger.error(`[monitor] cannot list containers: ${error.message}`);
        return null;
      }),
      Promise.all(probed.map(service => probe(service)))
    ]);
    return {
      host,
      containers: containers ? containers.filter(c => !ignored.has(c.name)) : [],
      dockerAvailable: containers !== null,
      services: serviceResults
    };
  }

  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const snap = await snapshot();
      return await alerter.run(snap);
    } catch (error) {
      logger.error(`[monitor] check failed: ${error.message}`);
      return null;
    } finally {
      busy = false;
    }
  }

  async function summary() {
    try {
      const snap = await snapshot();
      return await alerter.sendSummary(snap);
    } catch (error) {
      logger.error(`[monitor] summary failed: ${error.message}`);
      return null;
    }
  }

  return {
    tick,
    summary,
    snapshot,
    start() {
      if (running) return;
      running = true;
      // Host CPU needs a baseline sample, so collect once and report after a
      // short warm-up; the startup summary also proves the bot is wired up.
      hostCollector.collect().catch(() => {});
      warmupTimer = timers.setTimeout(async () => {
        // stop() may be called while these awaits run (settings saved during
        // warm-up); a stopped monitor must not arm its intervals afterwards
        await tick();
        if (!running) return;
        if (announceOnStart) await summary();
        if (!running) return;
        tickTimer = timers.setInterval(tick, intervalMs);
        if (summaryIntervalMs > 0) summaryTimer = timers.setInterval(summary, summaryIntervalMs);
      }, warmupMs);
    },
    stop() {
      running = false;
      timers.clearTimeout(warmupTimer);
      timers.clearInterval(tickTimer);
      timers.clearInterval(summaryTimer);
    }
  };
}

module.exports = { createMonitor };
