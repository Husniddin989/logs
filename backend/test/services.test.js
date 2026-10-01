const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const { probeService, probePostgres, parseReply } = require('../src/services');
const { createAlerter, evaluate, serviceCheck, summaryMessage, DEFAULT_THRESHOLDS } = require('../src/alerting');
const { createMonitor } = require('../src/monitor');

// Generated per run so no secret-looking literal is committed
const PASSWORD = `pw-${crypto.randomBytes(6).toString('hex')}`;

function recordingNotifier() {
  const messages = [];
  return { messages, send: async text => { messages.push(text); return true; } };
}

// A tiny Redis stand-in that understands AUTH, PING and INFO
async function fakeRedis({ password = null, info = {} } = {}) {
  const received = [];
  const server = net.createServer(socket => {
    let authed = !password;
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      // Commands arrive as RESP arrays; split them on "*<n>\r\n"
      const parts = buffer.split(/(?=\*\d+\r\n)/);
      buffer = '';
      for (const part of parts) {
        const args = part.split('\r\n').filter((line, i) => i > 0 && i % 2 === 0);
        const count = Number(part.slice(1, part.indexOf('\r\n')));
        if (args.length < count || !part.endsWith('\r\n')) { buffer = part; continue; }
        received.push(args);
        const [command] = args;
        if (command === 'AUTH') {
          authed = args.at(-1) === password;
          socket.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n');
        } else if (!authed) {
          socket.write('-NOAUTH Authentication required.\r\n');
        } else if (command === 'PING') {
          socket.write('+PONG\r\n');
        } else if (command === 'INFO') {
          const body = Object.entries({ redis_version: '7.2.4', connected_clients: 3, used_memory: 1048576, maxmemory: 0, ...info })
            .map(([key, value]) => `${key}:${value}`)
            .join('\r\n');
          const text = `# Server\r\n${body}\r\n`;
          socket.write(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    received,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

describe('Redis probe', () => {
  test('reads memory and clients after PING', async () => {
    const redis = await fakeRedis({ info: { used_memory: 50 * 1024 * 1024, maxmemory: 100 * 1024 * 1024 } });
    try {
      const result = await probeService({ id: 'r1', type: 'redis', name: 'cache', host: '127.0.0.1', port: redis.port });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.target, `127.0.0.1:${redis.port}`);
      assert.equal(result.clients, 3);
      assert.equal(result.usedMemory, 50 * 1024 * 1024);
      assert.equal(result.version, '7.2.4');
      assert.deepEqual(redis.received.map(args => args[0]), ['PING', 'INFO']);
    } finally {
      await redis.close();
    }
  });

  test('authenticates with the password, and a wrong one is reported without leaking it', async () => {
    const redis = await fakeRedis({ password: PASSWORD });
    try {
      const good = await probeService({ id: 'r1', type: 'redis', name: 'cache', host: '127.0.0.1', port: redis.port, password: PASSWORD });
      assert.equal(good.ok, true, good.error);

      const bad = await probeService({ id: 'r1', type: 'redis', name: 'cache', host: '127.0.0.1', port: redis.port, password: 'nope' });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /WRONGPASS/);

      const none = await probeService({ id: 'r1', type: 'redis', name: 'cache', host: '127.0.0.1', port: redis.port });
      assert.match(none.error, /NOAUTH/);
    } finally {
      await redis.close();
    }
  });

  test('a closed port is a failed probe, not an exception', async () => {
    const redis = await fakeRedis();
    const { port } = redis;
    await redis.close();
    const result = await probeService({ id: 'r1', type: 'redis', name: 'cache', host: '127.0.0.1', port });
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  });

  test('RESP replies split across packets wait for the rest', () => {
    assert.equal(parseReply(Buffer.from('$5\r\nhel')), null);
    assert.deepEqual(parseReply(Buffer.from('$5\r\nhello\r\n+OK\r\n')), { value: 'hello', next: 11 });
    assert.deepEqual(parseReply(Buffer.from('-ERR x\r\n')), { error: 'ERR x', next: 8 });
  });
});

describe('Postgres probe', () => {
  function fakeClient({ fail = null, row = {} } = {}) {
    const seen = {};
    class FakeClient {
      constructor(options) { seen.options = options; }
      on() {}
      async connect() { if (fail) throw new Error(fail); }
      async query(sql) {
        seen.sql = sql;
        return { rows: [{ connections: 12, max_connections: 100, size_bytes: '2048', version: '16.2', ...row }] };
      }
      async end() { seen.ended = true; }
    }
    return { FakeClient, seen };
  }

  test('reports connections against max_connections and closes the connection', async () => {
    const { FakeClient, seen } = fakeClient();
    const result = await probePostgres(
      { host: 'db', port: 5433, user: 'app', password: PASSWORD, database: 'main' },
      { ClientImpl: FakeClient }
    );
    assert.equal(result.ok, true);
    assert.equal(result.connections, 12);
    assert.equal(result.maxConnections, 100);
    assert.equal(result.sizeBytes, 2048);
    assert.equal(seen.options.port, 5433);
    assert.equal(seen.options.database, 'main');
    assert.equal(seen.options.ssl, false);
    assert.equal(seen.ended, true);
  });

  test('a failed login is reported and the password is scrubbed from the error', async () => {
    const { FakeClient, seen } = fakeClient({ fail: `password authentication failed (tried ${PASSWORD})` });
    const result = await probePostgres({ host: 'db', user: 'app', password: PASSWORD }, { ClientImpl: FakeClient });
    assert.equal(result.ok, false);
    assert.match(result.error, /password authentication failed/);
    assert.equal(result.error.includes(PASSWORD), false);
    assert.equal(seen.ended, true);
  });
});

describe('service checks', () => {
  const pg = { id: 'p1', type: 'postgres', name: 'main', target: 'db:5432', ok: true, latencyMs: 4, connections: 10, maxConnections: 100, sizeBytes: 1e9 };
  const redis = { id: 'r1', type: 'redis', name: 'cache', target: 'redis:6379', ok: true, latencyMs: 1, usedMemory: 1e6, maxMemory: 0, clients: 2 };

  test('down is CRITICAL, connection usage follows the thresholds', () => {
    assert.equal(serviceCheck(pg, DEFAULT_THRESHOLDS).level, 'ok');
    assert.equal(serviceCheck({ ...pg, connections: 85 }, DEFAULT_THRESHOLDS).level, 'warn');
    assert.equal(serviceCheck({ ...pg, connections: 99 }, DEFAULT_THRESHOLDS).level, 'critical');

    const down = serviceCheck({ ...pg, ok: false, error: 'connect ECONNREFUSED' }, DEFAULT_THRESHOLDS);
    assert.equal(down.level, 'critical');
    assert.equal(down.title, 'Postgres main');
    assert.match(down.detail, /javob bermayapti \(db:5432\): connect ECONNREFUSED/);
  });

  test('Redis without maxmemory is fine; with it, memory follows the thresholds', () => {
    assert.equal(serviceCheck(redis, DEFAULT_THRESHOLDS).level, 'ok');
    assert.equal(serviceCheck({ ...redis, maxMemory: 1.1e6 }, DEFAULT_THRESHOLDS).level, 'warn');
  });

  test('Postgres going down and coming back is alerted and listed in the report', async () => {
    let time = Date.UTC(2026, 9, 1, 9, 0, 0);
    const notifier = recordingNotifier();
    const alerter = createAlerter({ notifier, now: () => time });
    await alerter.run({ services: [pg, redis] });
    await alerter.run({ services: [{ ...pg, ok: false, error: 'timeout' }, redis] });
    time += 2 * 60 * 1000;
    await alerter.run({ services: [pg, redis] });

    assert.equal(notifier.messages.length, 2);
    assert.match(notifier.messages[0], /CRITICAL<\/b> — Postgres main/);
    assert.match(notifier.messages[1], /OK<\/b> — Postgres main/);
    assert.match(notifier.messages[1], /timedown: 2026-10-01 14:00:00\ntimeup: 2026-10-01 14:02:00/);

    const snap = { services: [pg, redis], containers: [] };
    const report = summaryMessage(snap, evaluate(snap));
    assert.match(report, /Postgres \/ Redis/);
    assert.match(report, /🟢 <b>Redis cache<\/b>/);
  });

  test('the monitor probes enabled services only', async () => {
    const probed = [];
    const monitor = createMonitor({
      docker: {},
      hostCollector: { collect: async () => null },
      alerter: { run: async () => ({}) },
      collect: async () => [],
      services: [
        { id: 'a', type: 'postgres', name: 'a', host: 'db' },
        { id: 'b', type: 'redis', name: 'b', host: 'redis', enabled: false }
      ],
      probe: async service => { probed.push(service.id); return { id: service.id, ok: true }; },
      logger: { error() {}, log() {} }
    });
    const snap = await monitor.snapshot();
    assert.deepEqual(probed, ['a']);
    assert.deepEqual(snap.services, [{ id: 'a', ok: true }]);
  });
});
