const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer } = require('./support/harness');
const { createFakeDocker } = require('./support/fakeDocker');
const {
  createAlertSettingsStore,
  defaultsFromConfig,
  applySettingsUpdate,
  publicSettings,
  tokenHint
} = require('../src/alertSettings');
const { createAlertService } = require('../src/alertService');
const { loadAlertConfig } = require('../src/config');

// Built at runtime so no token-shaped literal is committed
const TOKEN = `987654321:${'Bx'.repeat(18)}`;
const OTHER_TOKEN = `123123123:${'Zq'.repeat(18)}`;
const silent = { log() {}, error() {}, warn() {} };

// Fake timers so tests never leave real intervals running
function fakeTimers() {
  const active = new Set();
  let nextId = 1;
  const add = () => { const id = nextId++; active.add(id); return id; };
  return {
    active,
    setInterval: add,
    setTimeout: add,
    clearInterval: id => active.delete(id),
    clearTimeout: id => active.delete(id)
  };
}

function fakeNotifierFactory(outcome = { ok: true }) {
  const created = [];
  const factory = ({ botToken, chatId }) => {
    const notifier = {
      botToken,
      chatId,
      messages: [],
      send: async text => { notifier.messages.push(text); return outcome.ok; },
      sendWithResult: async text => { notifier.messages.push(text); return outcome; }
    };
    created.push(notifier);
    return notifier;
  };
  factory.created = created;
  return factory;
}

describe('alert settings helpers', () => {
  const base = defaultsFromConfig(loadAlertConfig({}));

  test('the token is never part of the public view', () => {
    const view = publicSettings({ ...base, botToken: TOKEN });
    assert.equal(view.botToken, undefined);
    assert.equal(view.hasBotToken, true);
    assert.equal(view.botTokenHint, tokenHint(TOKEN));
    assert.match(view.botTokenHint, /^987654321:…/);
    assert.equal(JSON.stringify(view).includes(TOKEN.split(':')[1]), false);
  });

  test('partial updates keep the saved token and report changed fields', () => {
    const saved = { ...base, botToken: TOKEN, chatId: '-100200', enabled: true };
    const result = applySettingsUpdate(saved, { thresholds: { diskWarn: 70 }, botToken: '' });
    assert.equal(result.error, undefined);
    assert.equal(result.settings.botToken, TOKEN);
    assert.equal(result.settings.thresholds.diskWarn, 70);
    assert.deepEqual(result.changes, ['thresholds']);
  });

  test('rejects invalid input with a readable message', () => {
    const cases = [
      [{ enabled: true }, /token va chat ID kerak/],
      [{ botToken: 'not-a-token' }, /Bot token/],
      [{ chatId: 'abc' }, /Chat ID/],
      [{ intervalSeconds: '5s' }, /15 soniyadan/],
      [{ intervalSeconds: 'soon' }, /ko‘rinishida/],
      [{ summarySeconds: '60' }, /300 soniyadan/],
      [{ thresholds: { cpuWarn: 96 } }, /Server CPU: WARN/],
      [{ thresholds: { diskCritical: 150 } }, /1 dan 100/],
      [{ thresholds: { restartWarn: 0 } }, /restartWarn/],
      [{ ignoreContainers: ['../etc'] }, /container nomi/],
      [{ hostname: 'x'.repeat(101) }, /100 belgi/],
      [[], /Invalid settings/]
    ];
    for (const [body, pattern] of cases) {
      assert.match(applySettingsUpdate(base, body).error || '', pattern, JSON.stringify(body));
    }
  });

  test('durations accept 60s / 15m / 12h, and 0 disables the report', () => {
    const { settings } = applySettingsUpdate(base, { intervalSeconds: '2m', renotifySeconds: '1h', summarySeconds: '0' });
    assert.equal(settings.intervalSeconds, 120);
    assert.equal(settings.renotifySeconds, 3600);
    assert.equal(settings.summarySeconds, 0);
  });

  test('clearing the token requires alerts to be off', () => {
    const saved = { ...base, botToken: TOKEN, chatId: '1', enabled: true };
    assert.match(applySettingsUpdate(saved, { clearBotToken: true }).error, /token va chat ID/);
    const { settings } = applySettingsUpdate(saved, { clearBotToken: true, enabled: false });
    assert.equal(settings.botToken, '');
  });

  test('the store falls back to env defaults and saves with owner-only permissions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-alerts-'));
    try {
      const store = createAlertSettingsStore(path.join(dir, 'alert-settings.json'), base);
      assert.equal(store.load().source, 'env');
      store.save({ ...base, chatId: '-1' });
      const loaded = store.load();
      assert.equal(loaded.source, 'saved');
      assert.equal(loaded.settings.chatId, '-1');
      assert.equal(fs.statSync(store.file).mode & 0o077, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('alert service', () => {
  test('saving settings replaces the running monitor instead of adding one', () => {
    const timers = fakeTimers();
    const factory = fakeNotifierFactory();
    const service = createAlertService({
      docker: createFakeDocker([]),
      createNotifier: factory,
      logger: silent,
      monitorOptions: { timers, collect: async () => [] }
    });
    const base = { ...defaultsFromConfig(loadAlertConfig({})), botToken: TOKEN, chatId: '1', enabled: true };

    assert.equal(service.apply(base), true);
    assert.equal(timers.active.size, 1, 'warm-up timer armed');
    service.apply({ ...base, intervalSeconds: 30 });
    assert.equal(timers.active.size, 1, 'previous monitor was stopped');
    assert.equal(service.status().running, true);

    assert.equal(service.apply({ ...base, enabled: false }), false);
    assert.equal(timers.active.size, 0);
    assert.equal(service.status().running, false);
  });
});

describe('alert settings API', () => {
  let srv;
  let dir;
  let service;
  let factory;
  let timers;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-alerts-api-'));
    timers = fakeTimers();
    factory = fakeNotifierFactory();
    const store = createAlertSettingsStore(path.join(dir, 'alert-settings.json'), defaultsFromConfig(loadAlertConfig({})));
    service = createAlertService({
      docker: createFakeDocker([]),
      createNotifier: factory,
      logger: silent,
      monitorOptions: { timers, collect: async () => [] }
    });
    srv = await startTestServer({
      users: [
        { username: 'admin', role: 'admin' },
        { username: 'alice', role: 'user', allowedContainers: [] }
      ],
      appOptions: { alerts: { store, service } }
    });
    srv.alertFile = store.file;
  });

  after(async () => {
    service.stop();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('only admins can read or change alert settings', async () => {
    const routes = [
      ['GET', '/api/alerts/settings'],
      ['PUT', '/api/alerts/settings'],
      ['POST', '/api/alerts/test'],
      ['POST', '/api/alerts/report'],
      ['GET', '/api/alerts/status']
    ];
    const aliceToken = await srv.tokenFor('alice');
    for (const [method, url] of routes) {
      assert.equal((await srv.request(method, url, { body: method === 'GET' ? undefined : {} })).status, 401, url);
      assert.equal((await srv.request(method, url, { token: aliceToken, body: method === 'GET' ? undefined : {} })).status, 403, url);
    }
  });

  test('saving a token enables alerts and the token never comes back', async () => {
    const token = await srv.tokenFor('admin');

    const initial = await srv.request('GET', '/api/alerts/settings', { token });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.source, 'env');
    assert.equal(initial.body.settings.hasBotToken, false);

    const saved = await srv.request('PUT', '/api/alerts/settings', {
      token,
      body: { enabled: true, botToken: TOKEN, chatId: '-1001234567890', hostname: 'prod-1' }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.settings.hasBotToken, true);
    assert.equal(saved.body.status.running, true);

    const reread = await srv.request('GET', '/api/alerts/settings', { token });
    assert.equal(reread.body.source, 'saved');
    for (const res of [saved, reread]) {
      assert.equal(JSON.stringify(res.body).includes(TOKEN), false, 'token leaked in response');
    }

    // Stored for the service, readable by the owner only
    assert.equal(JSON.parse(fs.readFileSync(srv.alertFile, 'utf8')).botToken, TOKEN);
    assert.equal(fs.statSync(srv.alertFile).mode & 0o077, 0);
    assert.equal(factory.created.at(-1).botToken, TOKEN);
  });

  test('updating other fields keeps the saved token', async () => {
    const token = await srv.tokenFor('admin');
    const res = await srv.request('PUT', '/api/alerts/settings', {
      token, body: { thresholds: { diskWarn: 75, diskCritical: 88 }, ignoreContainers: ['noisy'] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.thresholds.diskWarn, 75);
    assert.deepEqual(res.body.settings.ignoreContainers, ['noisy']);
    assert.equal(JSON.parse(fs.readFileSync(srv.alertFile, 'utf8')).botToken, TOKEN);
  });

  test('invalid settings are rejected and nothing is saved', async () => {
    const token = await srv.tokenFor('admin');
    const before = fs.readFileSync(srv.alertFile, 'utf8');
    const res = await srv.request('PUT', '/api/alerts/settings', { token, body: { thresholds: { memWarn: 99, memCritical: 90 } } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /WARN/);
    assert.equal(fs.readFileSync(srv.alertFile, 'utf8'), before);
  });

  test('test message uses the typed credentials and is rate limited', async () => {
    const token = await srv.tokenFor('admin');
    const res = await srv.request('POST', '/api/alerts/test', { token, body: { botToken: OTHER_TOKEN, chatId: '@my_channel' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const used = factory.created.at(-1);
    assert.equal(used.botToken, OTHER_TOKEN);
    assert.equal(used.chatId, '@my_channel');
    assert.match(used.messages[0], /Test xabari/);

    const tooSoon = await srv.request('POST', '/api/alerts/test', { token, body: {} });
    assert.equal(tooSoon.status, 429);
  });

  test('changes are audited without the token value', async () => {
    const entries = srv.auditEvents('admin.alert_settings_update');
    assert.ok(entries.length >= 2);
    assert.ok(entries[0].changes.includes('botToken'));
    assert.equal(JSON.stringify(srv.auditEntries).includes(TOKEN), false);
    assert.equal(JSON.stringify(srv.auditEntries).includes(OTHER_TOKEN), false);
  });
});

describe('alert test failures', () => {
  test('a Telegram rejection is reported to the admin as 502', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-alerts-fail-'));
    const store = createAlertSettingsStore(path.join(dir, 'a.json'), defaultsFromConfig(loadAlertConfig({})));
    const service = createAlertService({
      docker: createFakeDocker([]),
      createNotifier: fakeNotifierFactory({ ok: false, error: 'HTTP 400: Bad Request: chat not found' }),
      logger: silent
    });
    const srv = await startTestServer({ users: [{ username: 'admin', role: 'admin' }], appOptions: { alerts: { store, service } } });
    try {
      const res = await srv.request('POST', '/api/alerts/test', {
        token: await srv.tokenFor('admin'), body: { botToken: TOKEN, chatId: '1' }
      });
      assert.equal(res.status, 502);
      assert.match(res.body.error, /chat not found/);
      assert.equal(srv.auditEvents('admin.alert_test').at(-1).outcome, 'failure');
    } finally {
      service.stop();
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stopped monitor does not arm its intervals after warm-up', async () => {
    const { createMonitor } = require('../src/monitor');
    const timers = fakeTimers();
    let fireWarmup;
    timers.setTimeout = fn => { fireWarmup = fn; return 99; };
    let releaseTick;
    const monitor = createMonitor({
      docker: {},
      hostCollector: { collect: async () => null },
      alerter: { run: () => new Promise(r => { releaseTick = r; }), sendSummary: async () => '' },
      collect: async () => [],
      timers,
      logger: silent
    });
    monitor.start();
    const pending = fireWarmup();
    await new Promise(r => setImmediate(r));
    monitor.stop();
    releaseTick({ checks: [], sent: [] });
    await pending;
    assert.equal(timers.active.size, 0, 'no intervals after stop');
  });
});

