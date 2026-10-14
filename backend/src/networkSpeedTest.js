const fs = require('fs/promises');
const path = require('path');
const { performance } = require('node:perf_hooks');

const RETENTION_MS = 72 * 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const DEFAULT_ENDPOINT = 'https://speed.cloudflare.com';

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function createNetworkSpeedTest({
  filePath,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  now = Date.now,
  clock = performance,
  timeoutMs = 20000,
  downloadBytes = 10_000_000,
  downloadCount = 3,
  uploadBytes = 3_000_000,
  uploadCount = 3,
  latencyCount = 4,
  retentionMs = RETENTION_MS,
  cooldownMs = COOLDOWN_MS
}) {
  if (!filePath) throw new Error('Network speed-test history path is required');
  if (typeof fetchImpl !== 'function') throw new Error('Network speed testing requires fetch');
  let history = [];
  let initialized = false;
  let busy = false;
  let lastTestAt = 0;

  async function writeHistory() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    const contents = history.map(sample => JSON.stringify(sample)).join('\n');
    await fs.writeFile(temporaryPath, contents ? `${contents}\n` : '', { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      history = contents.split('\n').filter(Boolean).flatMap(line => {
        try {
          const sample = JSON.parse(line);
          return Number.isFinite(Date.parse(sample.timestamp)) ? [sample] : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    history = history.filter(sample => Date.parse(sample.timestamp) >= now() - retentionMs);
    lastTestAt = Date.parse(history[history.length - 1]?.timestamp) || 0;
    initialized = true;
    await writeHistory();
  }

  async function measureRequest(url, options, bodyBytes = 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = clock.now();
    let bytes = bodyBytes;
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: { 'cache-control': 'no-store', ...options.headers }
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Speed-test server javobi: HTTP ${response.status}`);
      }
      if (bodyBytes === 0 && response.body) {
        const reader = response.body.getReader();
        bytes = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value?.byteLength || 0;
        }
      } else if (response.body) {
        await response.arrayBuffer();
      }
      const durationSeconds = Math.max(0.001, (clock.now() - startedAt) / 1000);
      return { bytes, durationSeconds };
    } finally {
      clearTimeout(timeout);
    }
  }

  function testUrl(route, bytes) {
    const url = new URL(route, endpoint);
    if (bytes !== null) url.searchParams.set('bytes', String(bytes));
    url.searchParams.set('r', `${now()}-${Math.random().toString(36).slice(2)}`);
    return url.toString();
  }

  async function measureBatch(requests) {
    const startedAt = clock.now();
    const results = await Promise.all(requests);
    const durationSeconds = Math.max(0.001, (clock.now() - startedAt) / 1000);
    const bytes = results.reduce((total, result) => total + result.bytes, 0);
    return { bytes, durationSeconds, mbps: (bytes * 8) / durationSeconds / 1_000_000 };
  }

  async function run() {
    if (!initialized) await initialize();
    if (busy) {
      const error = new Error('Tezlik testi allaqachon bajarilmoqda');
      error.statusCode = 409;
      throw error;
    }
    const remainingCooldown = cooldownMs - (now() - lastTestAt);
    if (lastTestAt && remainingCooldown > 0) {
      const error = new Error(`Yangi testni ${Math.ceil(remainingCooldown / 1000)} soniyadan keyin boshlang`);
      error.statusCode = 429;
      throw error;
    }

    busy = true;
    // Apply the cooldown to failed attempts too, so repeated external errors
    // cannot turn one manual click into a sustained traffic loop.
    lastTestAt = now();
    try {
      const latencySamples = [];
      for (let index = 0; index < latencyCount; index += 1) {
        const result = await measureRequest(testUrl('/__down', 0), { method: 'GET' });
        latencySamples.push(result.durationSeconds * 1000);
      }

      const download = await measureBatch(Array.from({ length: downloadCount }, () => (
        measureRequest(testUrl('/__down', downloadBytes), { method: 'GET' })
      )));
      const upload = await measureBatch(Array.from({ length: uploadCount }, () => {
        const body = Buffer.alloc(uploadBytes);
        return measureRequest(testUrl('/__up', null), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body
        }, body.byteLength);
      }));

      const result = {
        timestamp: new Date(now()).toISOString(),
        provider: 'Cloudflare edge',
        downloadMbps: download.mbps,
        uploadMbps: upload.mbps,
        latencyMs: percentile(latencySamples, 0.5),
        downloadBytes: download.bytes,
        uploadBytes: upload.bytes
      };
      history.push(result);
      history = history.filter(sample => Date.parse(sample.timestamp) >= now() - retentionMs);
      await writeHistory();
      lastTestAt = Date.parse(result.timestamp);
      return result;
    } finally {
      busy = false;
    }
  }

  return {
    initialize,
    run,
    query(from, to) {
      return history.filter(sample => {
        const timestamp = Date.parse(sample.timestamp);
        return timestamp >= from && timestamp <= to;
      });
    },
    get retentionMs() { return retentionMs; },
    get cooldownMs() { return cooldownMs; }
  };
}

module.exports = { createNetworkSpeedTest, RETENTION_MS, COOLDOWN_MS };
