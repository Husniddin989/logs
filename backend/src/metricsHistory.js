const fs = require('fs/promises');
const path = require('path');
const { collectContainers } = require('./metrics');

const RETENTION_MS = 72 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function bytesPerSecond(current, previous, elapsedSeconds) {
  const currentValue = finiteNumber(current);
  const previousValue = finiteNumber(previous);
  if (currentValue === null || previousValue === null || elapsedSeconds <= 0) return null;
  const delta = currentValue - previousValue;
  return delta >= 0 ? delta / elapsedSeconds : null;
}

function historyShape(snapshot, timestamp, previous) {
  const elapsedSeconds = previous
    ? (Date.parse(timestamp) - Date.parse(previous.timestamp)) / 1000
    : 0;
  const previousContainers = new Map((previous?.containers || []).map(container => [container.id, container]));

  const host = snapshot.host || {};
  const hostNetwork = host.network ? { ...host.network } : null;
  if (hostNetwork) {
    const previousNetwork = previous?.host?.network;
    hostNetwork.rxBytesPerSecond = bytesPerSecond(hostNetwork.rxBytes, previousNetwork?.rxBytes, elapsedSeconds);
    hostNetwork.txBytesPerSecond = bytesPerSecond(hostNetwork.txBytes, previousNetwork?.txBytes, elapsedSeconds);
  }

  const containers = (snapshot.containers || []).map(container => {
    const old = previousContainers.get(container.id);
    const network = container.network ? { ...container.network } : null;
    if (network) {
      network.rxBytesPerSecond = bytesPerSecond(network.rxBytes, old?.network?.rxBytes, elapsedSeconds);
      network.txBytesPerSecond = bytesPerSecond(network.txBytes, old?.network?.txBytes, elapsedSeconds);
    }
    return {
      id: container.id,
      name: container.name,
      state: container.state,
      cpuPercent: finiteNumber(container.cpuPercent),
      memory: container.memory ? {
        used: finiteNumber(container.memory.used),
        limit: finiteNumber(container.memory.limit),
        percent: finiteNumber(container.memory.percent)
      } : null,
      network
    };
  });

  return {
    timestamp,
    host: {
      hostname: host.hostname || null,
      cpu: host.cpu || null,
      memory: host.memory || null,
      disk: host.disk || null,
      network: hostNetwork
    },
    containers
  };
}

function createMetricsHistory({
  filePath,
  hostCollector,
  docker,
  collect = collectContainers,
  logger = console,
  now = Date.now,
  timers = { setInterval, clearInterval }
}) {
  if (!filePath) throw new Error('Metrics history file path is required');
  if (!hostCollector || typeof hostCollector.collect !== 'function') throw new Error('Metrics history needs a host collector');
  if (!docker) throw new Error('Metrics history needs a Docker client');

  let samples = [];
  let initialized = false;
  let running = false;
  let busy = false;
  let timer = null;
  let lastPrunedAt = 0;

  function retainedSamples(cutoff) {
    return samples.filter(sample => {
      const timestamp = Date.parse(sample.timestamp);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  }

  async function rewriteFile() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const contents = samples.map(sample => JSON.stringify(sample)).join('\n');
    await fs.writeFile(tempPath, contents ? `${contents}\n` : '', { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      samples = contents.split('\n').filter(Boolean).flatMap(line => {
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
    samples = retainedSamples(now() - RETENTION_MS);
    lastPrunedAt = now();
    initialized = true;
    await rewriteFile();
  }

  async function collectOnce() {
    if (!initialized) await initialize();
    if (busy) return null;
    busy = true;
    try {
      const [host, containers] = await Promise.all([
        hostCollector.collect(),
        collect(docker, { logger }).catch(error => {
          logger.error(`[metrics-history] cannot list containers: ${error.message}`);
          return [];
        })
      ]);
      const timestamp = new Date(now()).toISOString();
      const sample = historyShape({ host, containers }, timestamp, samples[samples.length - 1]);
      samples.push(sample);
      samples = retainedSamples(now() - RETENTION_MS);

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(sample)}\n`, { encoding: 'utf8', mode: 0o600 });
      if (now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
        await rewriteFile();
        lastPrunedAt = now();
      }
      return sample;
    } catch (error) {
      logger.error(`[metrics-history] collection failed: ${error.message}`);
      return null;
    } finally {
      busy = false;
    }
  }

  return {
    initialize,
    collectOnce,
    start() {
      if (running) return;
      running = true;
      collectOnce();
      timer = timers.setInterval(collectOnce, SAMPLE_INTERVAL_MS);
      timer?.unref?.();
    },
    stop() {
      running = false;
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
    query(from, to) {
      return samples.filter(sample => {
        const timestamp = Date.parse(sample.timestamp);
        return timestamp >= from && timestamp <= to;
      });
    },
    get retentionMs() { return RETENTION_MS; },
    get sampleIntervalMs() { return SAMPLE_INTERVAL_MS; }
  };
}

module.exports = { createMetricsHistory, RETENTION_MS, SAMPLE_INTERVAL_MS };
