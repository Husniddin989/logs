const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramNotifier, escapeHtml } = require('../src/telegram');
const {
  createHostCollector,
  containerCpuPercent,
  containerMemory,
  readMemAvailable
} = require('../src/metrics');
const {
  createAlerter,
  evaluate,
  containerStateCheck,
  summaryMessage,
  renderTemplate,
  validateTemplate,
  formatTime,
  DEFAULT_THRESHOLDS,
  DEFAULT_TEMPLATE
} = require('../src/alerting');
const { createMonitor } = require('../src/monitor');
const { loadAlertConfig, ConfigError } = require('../src/config');

// Built at runtime so no token-shaped literal is committed
const FAKE_TOKEN = `123456789:${'A'.repeat(35)}`;
const silent = { error() {}, warn() {}, log() {} };

function fakeResponse(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function recordingNotifier() {
  const messages = [];
  return { messages, send: async text => { messages.push(text); return true; } };
}

function host({ cpu = 10, mem = 20, disk = 30 } = {}) {
  return {
    hostname: 'prod-1',
    uptimeSeconds: 3600,
    cpu: { percent: cpu, cores: 4, loadAvg: [0, 0, 0] },
    memory: { total: 8e9, used: (mem / 100) * 8e9, free: 0, percent: mem },
    disk: { path: '/', total: 100e9, used: (disk / 100) * 100e9, available: 1e9, percent: disk }
  };
}

function container(overrides = {}) {
  return {
    id: 'a'.repeat(64),
    name: 'web',
    image: 'web:latest',
    state: 'running',
    status: 'Up 1 hour',
    health: null,
    exitCode: 0,
    restartCount: 0,
    oomKilled: false,
    cpuPercent: 5,
    memory: { used: 100, limit: 1000, percent: 10 },
    ...overrides
  };
}

describe('Telegram notifier', () => {
  test('posts an HTML message to the configured chat', async () => {
    const calls = [];
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: '-100123',
      fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return fakeResponse(200); }
    });

    assert.equal(await notifier.send('<b>hi</b>'), true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendMessage$/);
    assert.equal(calls[0].body.chat_id, '-100123');
    assert.equal(calls[0].body.parse_mode, 'HTML');
    assert.equal(calls[0].body.text, '<b>hi</b>');
  });

  test('retries server errors, honours 429 retry_after and gives up quietly', async () => {
    const statuses = [500, 429, 200];
    const waits = [];
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: '1',
      fetchImpl: async () => fakeResponse(statuses.shift(), { parameters: { retry_after: 2 } }),
      sleep: async ms => { waits.push(ms); },
      logger: silent
    });
    assert.equal(await notifier.send('x'), true);
    assert.ok(waits.includes(2000), 'waited retry_after seconds');

    const failing = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: '1',
      fetchImpl: async () => { throw new Error('network down'); },
      sleep: async () => {},
      logger: silent
    });
    assert.equal(await failing.send('x'), false, 'network failure never throws');
  });

  test('does not retry a rejected (4xx) request', async () => {
    let calls = 0;
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: '1',
      fetchImpl: async () => { calls++; return fakeResponse(400, { description: 'chat not found' }); },
      sleep: async () => {},
      logger: silent
    });
    assert.equal(await notifier.send('x'), false);
    assert.equal(calls, 1);
  });

  test('sends queue in order, one at a time', async () => {
    const order = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: '1',
      fetchImpl: async (url, init) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        order.push(JSON.parse(init.body).text);
        inFlight--;
        return fakeResponse(200);
      }
    });
    await Promise.all(['1', '2', '3'].map(t => notifier.send(t)));
    assert.deepEqual(order, ['1', '2', '3']);
    assert.equal(maxInFlight, 1);
  });

  test('escapes HTML in interpolated values', () => {
    assert.equal(escapeHtml('<script>&'), '&lt;script&gt;&amp;');
  });

  test('never logs the bot token', async () => {
    const logged = [];
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: '1',
      fetchImpl: async () => fakeResponse(401, { description: 'Unauthorized' }),
      logger: { error: line => logged.push(line) }
    });
    await notifier.send('x');
    assert.ok(logged.length > 0);
    assert.ok(logged.every(line => !line.includes(FAKE_TOKEN)));
  });
});

describe('metrics', () => {
  test('host CPU is the busy share between two samples; first sample has no baseline', async () => {
    const samples = [
      [{ times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }],
      [{ times: { user: 400, nice: 0, sys: 0, idle: 1600, irq: 0 } }]
    ];
    const collector = createHostCollector({
      osImpl: {
        cpus: () => samples.shift(),
        totalmem: () => 1000,
        freemem: () => 250,
        hostname: () => 'h',
        uptime: () => 1,
        loadavg: () => [0, 0, 0]
      },
      statfs: async () => ({ bsize: 1, blocks: 1000, bfree: 300, bavail: 200 }),
      memAvailable: () => null
    });

    const first = await collector.collect();
    assert.equal(first.cpu.percent, null);
    assert.equal(first.memory.percent, 75);
    // used = 1000 - 300 = 700, df-style percent = 700 / (700 + 200)
    assert.equal(Math.round(first.disk.percent), 78);

    const second = await collector.collect();
    // delta busy 300 of delta total 1000
    assert.equal(second.cpu.percent, 30);
  });

  test('Linux MemAvailable is preferred over free pages for RAM usage', async () => {
    const meminfo = 'MemTotal:        4000 kB\nMemFree:          500 kB\nMemAvailable:    3000 kB\n';
    assert.equal(readMemAvailable(() => meminfo), 3000 * 1024);
    assert.equal(readMemAvailable(() => { throw new Error('ENOENT'); }), null);

    const collector = createHostCollector({
      osImpl: {
        cpus: () => [], totalmem: () => 4000 * 1024, freemem: () => 500 * 1024,
        hostname: () => 'h', uptime: () => 1, loadavg: () => [0, 0, 0]
      },
      statfs: async () => ({ bsize: 1, blocks: 1, bfree: 1, bavail: 1 }),
      memAvailable: () => readMemAvailable(() => meminfo)
    });
    // (4000 - 3000) / 4000, not (4000 - 500) / 4000
    assert.equal((await collector.collect()).memory.percent, 25);
  });

  test('disk read errors do not break collection', async () => {
    const collector = createHostCollector({
      statfs: async () => { throw new Error('ENOENT'); },
      logger: silent
    });
    const result = await collector.collect();
    assert.equal(result.disk, null);
    assert.ok(result.memory.total > 0);
  });

  test('container CPU and memory match docker stats semantics', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 600, limit: 1000, stats: { inactive_file: 100 } }
    };
    assert.equal(containerCpuPercent(stats), 40); // 200/1000 * 2 cores * 100
    assert.deepEqual(containerMemory(stats), { used: 500, limit: 1000, percent: 50 });
    assert.equal(containerCpuPercent({}), 0);
  });
});

describe('container state levels', () => {
  const t = DEFAULT_THRESHOLDS;
  const cases = [
    [{ state: 'running' }, 'ok'],
    [{ state: 'running', health: 'unhealthy' }, 'critical'],
    [{ state: 'running', health: 'starting' }, 'ok'],
    [{ state: 'running', restartCount: 5 }, 'warn'],
    [{ state: 'restarting', restartCount: 7 }, 'critical'],
    [{ state: 'paused' }, 'warn'],
    [{ state: 'created' }, 'warn'],
    [{ state: 'exited', exitCode: 0 }, 'warn'],
    [{ state: 'exited', exitCode: 137 }, 'critical'],
    [{ state: 'exited', exitCode: 1, oomKilled: true }, 'critical'],
    [{ state: 'dead' }, 'critical']
  ];
  for (const [overrides, expected] of cases) {
    test(`${JSON.stringify(overrides)} -> ${expected}`, () => {
      assert.equal(containerStateCheck(container(overrides), t).level, expected);
    });
  }
});

describe('evaluate', () => {
  test('server thresholds map to ok / warn / critical', () => {
    const levels = snapshot => Object.fromEntries(evaluate(snapshot).map(c => [c.key, c.level]));
    assert.deepEqual(levels({ host: host({ cpu: 50, mem: 85, disk: 95 }) }), {
      'server.cpu': 'ok', 'server.memory': 'warn', 'server.disk': 'critical'
    });
  });

  test('a stopped container has a state check but no CPU/RAM checks', () => {
    const keys = evaluate({ containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] }).map(c => c.key);
    assert.deepEqual(keys, ['container.web.state']);
  });

  test('host CPU without a baseline is skipped, not reported as ok', () => {
    const snap = { host: { ...host(), cpu: { percent: null, cores: 4 } } };
    assert.equal(evaluate(snap).some(c => c.key === 'server.cpu'), false);
  });
});

// 2026-10-01 14:00:00 in Tashkent (UTC+5)
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

describe('alerter', () => {
  function setup(renotifyMs = 30 * 60 * 1000, options = {}) {
    let time = T0;
    const notifier = recordingNotifier();
    const alerter = createAlerter({ notifier, renotifyMs, now: () => time, ...options });
    return { notifier, alerter, advance: ms => { time += ms; } };
  }

  test('healthy baseline sends nothing', async () => {
    const { notifier, alerter } = setup();
    await alerter.run({ host: host(), containers: [container()] });
    assert.equal(notifier.messages.length, 0);
  });

  test('sends on change, repeats a lasting problem after renotify, and announces recovery', async () => {
    const { notifier, alerter, advance } = setup(10 * 60 * 1000);

    await alerter.run({ host: host(), containers: [container()] });
    await alerter.run({ host: host(), containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] });
    assert.equal(notifier.messages.length, 1);
    assert.match(notifier.messages[0], /CRITICAL/);
    assert.match(notifier.messages[0], /exit code 1/);
    assert.match(notifier.messages[0], /timedown: 2026-10-01 14:00:00/);
    assert.match(notifier.messages[0], /timeup: —/);

    // Same state within the renotify window: silent
    advance(5 * 60 * 1000);
    await alerter.run({ host: host(), containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] });
    assert.equal(notifier.messages.length, 1);

    // Past the window: reminded
    advance(6 * 60 * 1000);
    await alerter.run({ host: host(), containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] });
    assert.equal(notifier.messages.length, 2);

    // Back up: recovery message
    await alerter.run({ host: host(), containers: [container()] });
    assert.equal(notifier.messages.length, 3);
    assert.match(notifier.messages[2], /🟢/);
    assert.match(notifier.messages[2], /tiklandi/);
    // The outage still started at the first failure, not at the reminder
    assert.match(notifier.messages[2], /timedown: 2026-10-01 14:00:00/);
    assert.match(notifier.messages[2], /timeup: 2026-10-01 14:11:00/);
  });

  test('every alert carries server name, ip, cpu, ram, disk, status and times', async () => {
    const { notifier, alerter } = setup(undefined, { message: { serverIp: '203.0.113.10' } });
    await alerter.run({ host: host({ cpu: 12, mem: 97, disk: 40 }) });
    const [text] = notifier.messages;
    const lines = text.split('\n');
    assert.equal(lines[0], '🔴 <b>CRITICAL</b> — Server RAM');
    assert.deepEqual(lines.slice(1).map(line => line.split(':')[0]), [
      'server name', 'ip', 'cpu', 'ram', 'joy', 'status', 'timedown', 'timeup'
    ]);
    assert.match(text, /server name: prod-1/);
    assert.match(text, /ip: 203\.0\.113\.10/);
    assert.match(text, /cpu: 12\.0%/);
    assert.match(text, /ram: 97\.0% \(7\.2 GB \/ 7\.5 GB\)/);
    assert.match(text, /joy: 40\.0%/);
  });

  test('a custom template is used, its values are escaped and its tags kept', async () => {
    const { notifier, alerter } = setup(undefined, {
      message: { template: '<b>{level}</b> {title} @ {server} [{change}] {duration}', timeZone: 'UTC' }
    });
    await alerter.run({ containers: [container({ name: '<evil>' })] });
    await alerter.run({ containers: [container({ name: '<evil>', state: 'dead' })] });
    assert.equal(notifier.messages[0], '<b>CRITICAL</b> Container &lt;evil&gt; @ server [OK → CRITICAL] 0s');
  });

  test('WARN -> CRITICAL -> OK reports one outage from the first WARN', async () => {
    const { notifier, alerter, advance } = setup(undefined, { message: { template: '{level} {timedown} {timeup} {duration}' } });
    await alerter.run({ host: host({ disk: 85 }) });
    advance(60 * 1000);
    await alerter.run({ host: host({ disk: 95 }) });
    advance(4 * 60 * 1000 + 5000);
    await alerter.run({ host: host({ disk: 20 }) });
    assert.deepEqual(notifier.messages, [
      'WARN 2026-10-01 14:00:00 — 0s',
      'CRITICAL 2026-10-01 14:00:00 — 1m 0s',
      'OK 2026-10-01 14:00:00 2026-10-01 14:05:05 5m 5s'
    ]);
  });

  test('a stopped container is down since Docker says it stopped, and up since it started', async () => {
    const { notifier, alerter, advance } = setup(undefined, { message: { template: '{timedown} | {timeup}' } });
    await alerter.run({ containers: [container()] });
    const stoppedAt = new Date(T0 - 3 * 60 * 1000).toISOString();
    await alerter.run({ containers: [container({ state: 'exited', exitCode: 1, finishedAt: stoppedAt })] });
    advance(10 * 60 * 1000);
    const startedAt = new Date(T0 + 8 * 60 * 1000).toISOString();
    await alerter.run({ containers: [container({ startedAt })] });
    assert.deepEqual(notifier.messages, [
      '2026-10-01 13:57:00 | —',
      '2026-10-01 13:57:00 | 2026-10-01 14:08:00'
    ]);
  });

  test('container CPU and RAM are not alerted unless turned on', async () => {
    const busy = { containers: [container({ cpuPercent: 150, memory: { used: 990, limit: 1000, percent: 99 } })] };
    const off = setup();
    await off.alerter.run(busy);
    assert.equal(off.notifier.messages.length, 0);

    const on = setup(undefined, { checks: { containerResources: true } });
    await on.alerter.run(busy);
    assert.equal(on.notifier.messages.length, 2);
    assert.match(on.notifier.messages.join('\n'), /Container web CPU/);
  });

  test('turning a check group off drops its pending problems silently', async () => {
    const state = new Map();
    const first = setup(undefined, { state, checks: { containerResources: true } });
    await first.alerter.run({ containers: [container({ cpuPercent: 99 })] });
    assert.equal(first.notifier.messages.length, 1);

    const second = setup(undefined, { state });
    await second.alerter.run({ containers: [container({ cpuPercent: 99 })] });
    assert.equal(second.notifier.messages.length, 0);
    assert.equal(state.has('container.web.cpu'), false);
  });

  test('warn escalating to critical sends both steps', async () => {
    const { notifier, alerter } = setup();
    await alerter.run({ host: host({ disk: 50 }) });
    await alerter.run({ host: host({ disk: 85 }) });
    await alerter.run({ host: host({ disk: 92 }) });
    assert.equal(notifier.messages.length, 2);
    assert.match(notifier.messages[0], /WARN.*disk/i);
    assert.match(notifier.messages[1], /CRITICAL.*disk/i);
  });

  test('a problem already present at startup is reported immediately', async () => {
    const { notifier, alerter } = setup();
    await alerter.run({ host: host({ mem: 97 }) });
    assert.equal(notifier.messages.length, 1);
    assert.match(notifier.messages[0], /CRITICAL.*RAM/);
  });

  test('stopping a container does not produce a fake CPU "recovered" message', async () => {
    const { notifier, alerter } = setup(undefined, { checks: { containerResources: true } });
    await alerter.run({ containers: [container({ cpuPercent: 99 })] });
    notifier.messages.length = 0;
    await alerter.run({ containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] });
    assert.equal(notifier.messages.length, 1);
    assert.match(notifier.messages[0], /xato bilan/);
  });

  test('removing a failing container reports it once and forgets it', async () => {
    const { notifier, alerter } = setup();
    await alerter.run({ containers: [container({ name: 'my.app', state: 'exited', exitCode: 2, cpuPercent: null, memory: null })] });
    await alerter.run({ containers: [] });
    assert.equal(notifier.messages.length, 2);
    assert.match(notifier.messages[1], /my\.app/);
    assert.match(notifier.messages[1], /o‘chirildi/);
    await alerter.run({ containers: [] });
    assert.equal(notifier.messages.length, 2);
  });

  test('Docker going away raises one alert and keeps container states', async () => {
    const { notifier, alerter } = setup();
    await alerter.run({ dockerAvailable: true, containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] });
    notifier.messages.length = 0;

    await alerter.run({ dockerAvailable: false, containers: [] });
    assert.equal(notifier.messages.length, 1);
    assert.match(notifier.messages[0], /Docker/);

    // Docker is back and the container is still down: no duplicate alert
    await alerter.run({ dockerAvailable: true, containers: [container({ state: 'exited', exitCode: 1, cpuPercent: null, memory: null })] });
    assert.equal(notifier.messages.length, 2);
    assert.match(notifier.messages[1], /Docker/);
    assert.match(notifier.messages[1], /tiklandi/);
  });

  test('container names are HTML-escaped in messages', async () => {
    const { notifier, alerter } = setup();
    await alerter.run({ containers: [container({ name: '<evil>', state: 'dead' })] });
    assert.match(notifier.messages[0], /&lt;evil&gt;/);
    assert.doesNotMatch(notifier.messages[0], /<evil>/);
  });

  test('the status report lists the server and every container', () => {
    const snap = {
      host: host({ cpu: 40, mem: 60, disk: 70 }),
      containers: [container(), container({ name: 'db', state: 'exited', exitCode: 1, cpuPercent: null, memory: null })]
    };
    const text = summaryMessage(snap, evaluate(snap));
    assert.match(text, /Holat hisoboti/);
    assert.match(text, /CPU: 40\.0%/);
    assert.match(text, /1\/2 ishlayapti/);
    assert.match(text, /🟢 <b>web<\/b>/);
    assert.match(text, /🔴 <b>db<\/b>.*exit 1/);
    assert.ok(text.startsWith('🔴'), 'report icon reflects the worst check');
    assert.doesNotMatch(text, /CPU 5\.0%/, 'container CPU is left out while its alerts are off');
  });
});

describe('message template', () => {
  test('the default has the requested lines', () => {
    assert.match(DEFAULT_TEMPLATE, /server name: \{server\}\nip: \{ip\}\ncpu: \{cpu\}\nram: \{ram\}\njoy: \{disk\}\nstatus: \{status\}\ntimedown: \{timedown\}\ntimeup: \{timeup\}/);
    assert.equal(validateTemplate(DEFAULT_TEMPLATE), null);
  });

  test('text typed in the template is escaped except the allowed tags', () => {
    assert.equal(renderTemplate('<b>{title}</b> a<b & <script>', { title: 'x' }), '<b>x</b> a&lt;b &amp; &lt;script&gt;');
    assert.equal(renderTemplate('{unknown} {title}', { title: '<t>' }), '{unknown} &lt;t&gt;');
  });

  test('typos and broken tags are rejected before they can lose alerts', () => {
    assert.match(validateTemplate('{servr}'), /Noma’lum.*\{servr\}/);
    assert.match(validateTemplate('<b>{title}'), /yopilmagan/);
    assert.match(validateTemplate('<b>{title}</i>'), /juft emas/);
    assert.match(validateTemplate('   '), /bo‘sh/);
    assert.match(validateTemplate('x'.repeat(2001)), /2000/);
  });

  test('times are shown in the configured time zone', () => {
    assert.equal(formatTime(T0, 'Asia/Tashkent'), '2026-10-01 14:00:00');
    assert.equal(formatTime(T0, 'UTC'), '2026-10-01 09:00:00');
    assert.equal(formatTime(null), '—');
  });
});

describe('monitor', () => {
  test('ignored containers are left out and overlapping ticks are skipped', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const snapshots = [];
    const monitor = createMonitor({
      docker: {},
      hostCollector: { collect: async () => host() },
      alerter: { run: async snap => { snapshots.push(snap); await gate; return { sent: [] }; }, sendSummary: async () => '' },
      ignoreContainers: ['noisy'],
      collect: async () => [container(), container({ name: 'noisy' })],
      logger: silent
    });

    const first = monitor.tick();
    const second = await monitor.tick();
    assert.equal(second, null, 'second tick skipped while the first runs');
    release();
    await first;

    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].containers.map(c => c.name), ['web']);
    assert.equal(snapshots[0].dockerAvailable, true);
  });

  test('GitLab Runner job containers and name patterns are left out', async () => {
    const runnerName = 'runner-arwqbwzgd-project-67149786-concurrent-0-5e3fa1c4aad0716a-predefined';
    const all = [
      container(),
      container({ name: 'gitlab-runner' }),
      container({ name: runnerName, state: 'exited', exitCode: 0 }),
      container({ name: 'build-helper', labels: { 'com.gitlab.gitlab-runner.managed': 'true' } }),
      container({ name: 'preview-123' })
    ];
    const snapshotWith = options => createMonitor({
      docker: {},
      hostCollector: { collect: async () => null },
      alerter: { run: async () => ({}) },
      collect: async () => all,
      logger: silent,
      ...options
    }).snapshot();

    const byDefault = await snapshotWith({ ignoreContainers: ['preview-*'] });
    assert.deepEqual(byDefault.containers.map(c => c.name), ['web', 'gitlab-runner']);
    assert.deepEqual(byDefault.ignoredContainers, [runnerName, 'build-helper', 'preview-123']);

    const runnersWatched = await snapshotWith({ ignoreCiRunners: false });
    assert.equal(runnersWatched.containers.length, 5);
  });

  test('a container that becomes ignored is dropped without a "removed" message', async () => {
    const notifier = recordingNotifier();
    const alerter = createAlerter({ notifier });
    const stopped = container({ name: 'runner-x-project-1-concurrent-0-abc', state: 'exited', exitCode: 0 });
    await alerter.run({ containers: [stopped] });
    assert.equal(notifier.messages.length, 1);
    await alerter.run({ containers: [], ignoredContainers: [stopped.name] });
    assert.equal(notifier.messages.length, 1);
  });

  test('a Docker failure yields dockerAvailable: false instead of throwing', async () => {
    const monitor = createMonitor({
      docker: {},
      hostCollector: { collect: async () => host() },
      alerter: { run: async snap => snap, sendSummary: async () => '' },
      collect: async () => { throw new Error('socket closed'); },
      logger: silent
    });
    const snap = await monitor.tick();
    assert.equal(snap.dockerAvailable, false);
    assert.deepEqual(snap.containers, []);
  });
});

describe('alert configuration', () => {
  test('disabled unless both Telegram settings are present', () => {
    assert.equal(loadAlertConfig({}).enabled, false);
    assert.throws(() => loadAlertConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN }), ConfigError);
    assert.throws(() => loadAlertConfig({ TELEGRAM_CHAT_ID: '1' }), ConfigError);
    assert.equal(loadAlertConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: '1' }).enabled, true);
    assert.equal(loadAlertConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: '1', ALERT_ENABLED: 'false' }).enabled, false);
  });

  test('rejects malformed tokens and inverted thresholds', () => {
    assert.throws(() => loadAlertConfig({ TELEGRAM_BOT_TOKEN: 'nope', TELEGRAM_CHAT_ID: '1' }), /bot token/);
    assert.throws(() => loadAlertConfig({ ALERT_CPU_WARN: '95', ALERT_CPU_CRITICAL: '90' }), /warn must be lower/);
    assert.throws(() => loadAlertConfig({ ALERT_DISK_WARN: '150' }), /between 1 and 100/);
  });

  test('an optional self-hosted Bot API base URL is validated', () => {
    const creds = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: '1' };
    assert.equal(loadAlertConfig(creds).telegram.apiBase, undefined);
    assert.equal(loadAlertConfig({ ...creds, TELEGRAM_API_BASE: 'http://tg-api:8081/' }).telegram.apiBase, 'http://tg-api:8081');
    assert.throws(() => loadAlertConfig({ ...creds, TELEGRAM_API_BASE: 'ftp://x' }), /http\(s\) URL/);
  });

  test('defaults and overrides', () => {
    const config = loadAlertConfig({
      ALERT_INTERVAL: '30s',
      ALERT_SUMMARY_INTERVAL: '0',
      ALERT_IGNORE_CONTAINERS: 'a, b',
      ALERT_DISK_PATH: '/host'
    });
    assert.equal(config.intervalSeconds, 30);
    assert.equal(config.summarySeconds, 0);
    assert.equal(config.renotifySeconds, 1800);
    assert.deepEqual(config.ignoreContainers, ['a', 'b']);
    assert.equal(config.diskPath, '/host');
    assert.equal(config.thresholds.diskCritical, 90);
  });
});
