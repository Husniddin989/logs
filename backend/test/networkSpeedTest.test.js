const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createNetworkSpeedTest } = require('../src/networkSpeedTest');

test('manual speed test measures both directions and persists a queryable result', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dlv-speed-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const filePath = path.join(dataDir, 'speed-tests.ndjson');
  const requests = [];
  let now = Date.parse('2026-10-15T10:00:00.000Z');
  const service = createNetworkSpeedTest({
    filePath,
    endpoint: 'https://speed-test.example',
    now: () => now,
    latencyCount: 1,
    downloadBytes: 8,
    downloadCount: 2,
    uploadBytes: 4,
    uploadCount: 2,
    cooldownMs: 60_000,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (options.method === 'POST') return new Response(null, { status: 200 });
      const bytes = Number(new URL(url).searchParams.get('bytes'));
      return new Response(Buffer.alloc(bytes), { status: 200 });
    }
  });

  await service.initialize();
  const result = await service.run();
  assert.equal(result.provider, 'Cloudflare edge');
  assert.equal(result.downloadBytes, 16);
  assert.equal(result.uploadBytes, 8);
  assert.ok(Number.isFinite(result.downloadMbps) && result.downloadMbps > 0);
  assert.ok(Number.isFinite(result.uploadMbps) && result.uploadMbps > 0);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 2);
  assert.equal(requests.filter(request => request.options.method === 'GET').length, 3);

  const persisted = (await fs.readFile(filePath, 'utf8')).trim().split('\n');
  assert.equal(persisted.length, 1);
  assert.deepEqual(service.query(now - 1, now + 1), [result]);
  await assert.rejects(service.run(), error => error.statusCode === 429);
});

test('speed-test startup prunes results older than 72 hours', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dlv-speed-test-prune-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-15T10:00:00.000Z');
  const filePath = path.join(dataDir, 'speed-tests.ndjson');
  await fs.writeFile(filePath, `${JSON.stringify({ timestamp: new Date(now - 72 * 60 * 60 * 1000 - 1).toISOString() })}\n`);
  const service = createNetworkSpeedTest({ filePath, now: () => now });

  await service.initialize();
  assert.deepEqual(service.query(now - 72 * 60 * 60 * 1000, now), []);
  assert.equal((await fs.readFile(filePath, 'utf8')).trim(), '');
});
