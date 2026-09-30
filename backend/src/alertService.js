const { createTelegramNotifier, escapeHtml } = require('./telegram');
const { createHostCollector } = require('./metrics');
const { createAlerter } = require('./alerting');
const { createMonitor } = require('./monitor');
const { isSendable } = require('./alertSettings');

// Owns the running monitor and rebuilds it whenever an admin saves new
// settings, without restarting the process. Alert state survives rebuilds,
// so a problem that is already known is not announced again after a save.
function createAlertService({
  docker,
  diskPath = '/',
  apiBase,
  logger = console,
  createNotifier = createTelegramNotifier,
  createCollector = createHostCollector,
  monitorOptions = {}
}) {
  const state = new Map();
  let monitor = null;
  let current = null;
  let lastRun = null; // { at, checks, sent }

  function forgetIgnored(names) {
    for (const name of names) {
      for (const suffix of ['state', 'cpu', 'memory']) state.delete(`container.${name}.${suffix}`);
    }
  }

  function apply(settings, { announce = false } = {}) {
    if (monitor) monitor.stop();
    monitor = null;
    current = settings;

    if (!isSendable(settings)) {
      logger.log('[alerts] Telegram alerts are off');
      return false;
    }

    // Containers that became ignored must not later look like "removed"
    forgetIgnored(settings.ignoreContainers);

    const notifier = createNotifier({ botToken: settings.botToken, chatId: settings.chatId, apiBase, logger });
    const alerter = createAlerter({
      notifier,
      thresholds: settings.thresholds,
      renotifyMs: settings.renotifySeconds * 1000,
      state,
      logger
    });
    const observed = {
      async run(snapshot) {
        const result = await alerter.run(snapshot);
        lastRun = { at: new Date().toISOString(), checks: result.checks, sent: result.sent.length };
        return result;
      },
      sendSummary: snapshot => alerter.sendSummary(snapshot)
    };

    monitor = createMonitor({
      docker,
      hostCollector: createCollector({ diskPath, hostname: settings.hostname || null, logger }),
      alerter: observed,
      intervalMs: settings.intervalSeconds * 1000,
      summaryIntervalMs: settings.summarySeconds * 1000,
      ignoreContainers: settings.ignoreContainers,
      announceOnStart: announce,
      logger,
      ...monitorOptions
    });
    monitor.start();
    logger.log(`[alerts] Telegram alerts on: every ${settings.intervalSeconds}s`);
    return true;
  }

  // Sends one message with the given (possibly not yet saved) credentials so
  // the admin can check them before saving. Returns { ok, error }.
  async function sendTest({ botToken, chatId, hostname }) {
    const notifier = createNotifier({ botToken, chatId, apiBase, logger, maxAttempts: 1 });
    const name = hostname || current?.hostname || 'server';
    return notifier.sendWithResult(
      `✅ <b>Test xabari</b>\nDocker Log Viewer alertlari shu chatga keladi.\n<i>host: ${escapeHtml(name)}</i>`
    );
  }

  // Sends the full status report now (the "Send report" button)
  async function sendReport() {
    if (!monitor) return { ok: false, error: 'Alertlar o‘chirilgan' };
    const message = await monitor.summary();
    return message ? { ok: true } : { ok: false, error: 'Hisobotni yuborib bo‘lmadi' };
  }

  function status() {
    return {
      running: Boolean(monitor),
      lastRunAt: lastRun?.at || null,
      checks: (lastRun?.checks || []).map(({ key, level, scope, container, title, detail }) => (
        { key, level, scope, container, title, detail }
      ))
    };
  }

  function stop() {
    if (monitor) monitor.stop();
    monitor = null;
  }

  return { apply, sendTest, sendReport, status, stop };
}

module.exports = { createAlertService };
