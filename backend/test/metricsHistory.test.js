const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMetricsHistory, RETENTION_MS, SAMPLE_INTERVAL_MS } = require('../src/metricsHistory');
const { startTestServer } = require('./support/harness');

function hostSnapshot(rxBytes, txBytes) {
  return {
    hostname: 'monitor-test',
    cpu: { percent: 20, cores: 4, loadAvg: [0.5, 0.4, 0.3] },
    memory: { used: 20, total: 100, free: 80, percent: 20 },
    disk: { used: 30, total: 100, available: 70, percent: 30 },
    network: { rxBytes, txBytes, source: 'server' }
  };
}

function containerSnapshot(rxBytes, txBytes) {
  return [{
    id: 'container-1',
    name: 'web',
    state: 'running',
    cpuPercent: 5,
    memory: { used: 10, limit: 100, percent: 10 },
    network: { rxBytes, txBytes }
  }];
}

test('metrics history persists one-minute samples and derives network rates', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dlv-metrics-history-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  let clock = Date.parse('2026-10-15T10:00:00.000Z');
  let host = hostSnapshot(1000, 2000);
  let containers = containerSnapshot(3000, 4000);
  const history = createMetricsHistory({
    filePath: path.join(dataDir, 'metrics-history.ndjson'),
    hostCollector: { collect: async () => host },
    docker: {},
    collect: async () => containers,
    logger: { error() {} },
    now: () => clock
  });

  await history.initialize();
  await history.collectOnce();
  clock += SAMPLE_INTERVAL_MS;
  host = hostSnapshot(7000, 8000);
  containers = containerSnapshot(9000, 10000);
  await history.collectOnce();

  const samples = history.query(clock - SAMPLE_INTERVAL_MS, clock);
  assert.equal(samples.length, 2);
  assert.equal(samples[1].host.network.rxBytesPerSecond, 100);
  assert.equal(samples[1].host.network.txBytesPerSecond, 100);
  assert.equal(samples[1].containers[0].network.rxBytesPerSecond, 100);
  assert.equal(samples[1].containers[0].network.txBytesPerSecond, 100);
  assert.equal(history.sampleIntervalMs, 60000);

  const persisted = (await fs.readFile(path.join(dataDir, 'metrics-history.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(persisted.length, 2);
  assert.equal(JSON.parse(persisted[1]).containers[0].name, 'web');
});

test('startup prunes metrics older than the 72-hour retention window', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dlv-metrics-prune-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const now = Date.parse('2026-10-15T10:00:00.000Z');
  const filePath = path.join(dataDir, 'metrics-history.ndjson');
  const expired = { timestamp: new Date(now - RETENTION_MS - 1).toISOString(), host: {}, containers: [] };
  await fs.writeFile(filePath, `${JSON.stringify(expired)}\n`);
  const history = createMetricsHistory({
    filePath,
    hostCollector: { collect: async () => hostSnapshot(0, 0) },
    docker: {},
    collect: async () => [],
    logger: { error() {} },
    now: () => now
  });

  await history.initialize();
  assert.deepEqual(history.query(now - RETENTION_MS, now), []);
  assert.equal((await fs.readFile(filePath, 'utf8')).trim(), '');
});

test('monitor history is admin-only and rejects ranges longer than 72 hours', async t => {
  const captured = [];
  const metricsHistory = {
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    query(from, to) {
      captured.push({ from, to });
      return [{ timestamp: new Date(from).toISOString(), host: {}, containers: [] }];
    }
  };
  const server = await startTestServer({
    users: [
      { username: 'admin', role: 'admin' },
      { username: 'viewer', role: 'user' }
    ],
    appOptions: { metricsHistory }
  });
  t.after(() => server.close());

  const adminToken = await server.tokenFor('admin');
  const viewerToken = await server.tokenFor('viewer');
  const adminResponse = await server.request('GET', '/api/monitor/history', { token: adminToken });
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.body.retentionHours, 72);
  assert.equal(adminResponse.body.sampleIntervalSeconds, 60);
  assert.equal(adminResponse.body.samples.length, 1);

  const viewerResponse = await server.request('GET', '/api/monitor/history', { token: viewerToken });
  assert.equal(viewerResponse.status, 403);

  const from = new Date(Date.now() - RETENTION_MS - 1000).toISOString();
  const to = new Date().toISOString();
  const longRange = await server.request('GET', `/api/monitor/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token: adminToken });
  assert.equal(longRange.status, 400);
  assert.equal(captured.length, 1);
});
