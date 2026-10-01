const { createTelegramNotifier, escapeHtml } = require('./telegram');
const { createHostCollector } = require('./metrics');
const { createAlerter, sampleMessages } = require('./alerting');
const { createMonitor } = require('./monitor');
const { probeService } = require('./services');
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
  probe = probeService,
  monitorOptions = {}
}) {
  const state = new Map();
  let monitor = null;
  let current = null;
  let lastRun = null; // { at, checks, sent }
  let lastHost = null; // latest server reading, for message previews

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
      checks: settings.checks,
      message: messageOptions(settings),
      renotifyMs: settings.renotifySeconds * 1000,
      state,
      logger
    });
    const observed = {
      async run(snapshot) {
        if (snapshot.host) lastHost = snapshot.host;
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
      ignoreCiRunners: settings.ignoreCiRunners !== false,
      services: settings.services || [],
      probe,
      announceOnStart: announce,
      logger,
      ...monitorOptions
    });
    monitor.start();
    logger.log(`[alerts] Telegram alerts on: every ${settings.intervalSeconds}s`);
    return true;
  }

  function messageOptions(settings) {
    return { template: settings.messageTemplate, serverIp: settings.serverIp, timeZone: settings.timezone };
  }

  // Example "down" and "recovered" alerts rendered with the given (possibly
  // not yet saved) message settings and the latest server reading
  async function preview(settings) {
    let host = lastHost;
    if (!host) {
      // CPU usage needs two samples; the monitor has not taken any yet
      const collector = createCollector({ diskPath, hostname: settings.hostname || null, logger });
      host = await collector.collect()
        .then(() => new Promise(resolve => setTimeout(resolve, 300)))
        .then(() => collector.collect())
        .catch(() => null);
    }
    const name = settings.hostname || host?.hostname || 'server';
    return sampleMessages({ ...messageOptions(settings), host, hostname: name });
  }

  // Sends one message with the given (possibly not yet saved) credentials so
  // the admin can check them before saving, followed by an example alert in
  // the configured format. Returns { ok, error }.
  async function sendTest({ botToken, chatId, settings }) {
    const notifier = createNotifier({ botToken, chatId, apiBase, logger, maxAttempts: 1 });
    const name = settings?.hostname || current?.hostname || 'server';
    const example = settings ? (await preview(settings)).down : null;
    const lines = [`✅ <b>Test xabari</b>`, `Docker Log Viewer alertlari shu chatga keladi.`, `<i>host: ${escapeHtml(name)}</i>`];
    if (example) lines.push('', '<i>Alertlar shu ko‘rinishda keladi (namuna):</i>', '', example);
    return notifier.sendWithResult(lines.join('\n'));
  }

  // One probe of a Postgres / Redis entry, for the "Tekshirish" button
  function testService(service) {
    return probe(service);
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

  return { apply, sendTest, sendReport, preview, testService, status, stop };
}

module.exports = { createAlertService };
