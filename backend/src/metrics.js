const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

// On Linux "available" memory (free + reclaimable cache) is what `free -h`
// reports and what matters for alerts; MemFree alone overstates usage.
// Returns bytes, or null when /proc/meminfo is not there (macOS, Windows).
function readMemAvailable(readFile = fs.readFileSync) {
  try {
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(readFile('/proc/meminfo', 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function percent(part, whole) {
  if (!whole || whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

// Sums the per-core times reported by os.cpus() into one busy/total pair
function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const [mode, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (mode === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

// Host CPU usage needs two samples, so the collector keeps the previous one.
// The first call after startup has no baseline and reports null.
function createHostCollector({
  osImpl = os,
  statfs = fsp.statfs,
  memAvailable = () => readMemAvailable(),
  diskPath = '/',
  // Inside a container os.hostname() is the container ID; let the operator
  // name the server as it should appear in alerts
  hostname = null,
  logger = console
} = {}) {
  let previousCpu = null;

  async function disk() {
    try {
      const stat = await statfs(diskPath);
      const blockSize = Number(stat.bsize);
      const total = Number(stat.blocks) * blockSize;
      const available = Number(stat.bavail) * blockSize;
      const used = (Number(stat.blocks) - Number(stat.bfree)) * blockSize;
      return {
        path: diskPath,
        total,
        used,
        available,
        // df-style: usage relative to what this user can actually occupy
        percent: percent(used, used + available)
      };
    } catch (error) {
      logger.error(`[metrics] cannot read disk usage for ${diskPath}: ${error.message}`);
      return null;
    }
  }

  return {
    async collect() {
      const cpus = osImpl.cpus() || [];
      const sample = cpuTotals(cpus);

      let cpuPercent = null;
      if (previousCpu) {
        const totalDelta = sample.total - previousCpu.total;
        const idleDelta = sample.idle - previousCpu.idle;
        if (totalDelta > 0) cpuPercent = percent(totalDelta - idleDelta, totalDelta);
      }
      previousCpu = sample;

      const totalMem = osImpl.totalmem();
      const freeMem = memAvailable() ?? osImpl.freemem();

      return {
        hostname: hostname || osImpl.hostname(),
        uptimeSeconds: osImpl.uptime(),
        cpu: { percent: cpuPercent, cores: cpus.length, loadAvg: osImpl.loadavg() },
        memory: { total: totalMem, used: totalMem - freeMem, free: freeMem, percent: percent(totalMem - freeMem, totalMem) },
        disk: await disk()
      };
    }
  };
}

// Docker reports counters, so CPU percent is the delta between the two
// samples Docker includes in one stats reading.
function containerCpuPercent(stats) {
  const cpu = stats?.cpu_stats;
  const pre = stats?.precpu_stats;
  if (!cpu?.cpu_usage || !pre?.cpu_usage) return 0;

  const cpuDelta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
  const systemDelta = cpu.system_cpu_usage - pre.system_cpu_usage;
  if (!(systemDelta > 0) || !(cpuDelta > 0)) return 0;

  const cores = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  return Math.max(0, (cpuDelta / systemDelta) * cores * 100);
}

// Docker counts the page cache in memory_stats.usage; subtracting it matches
// what `docker stats` shows and avoids false "memory nearly full" alerts.
function containerMemory(stats) {
  const mem = stats?.memory_stats;
  if (!mem) return { used: 0, limit: 0, percent: 0 };
  const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
  const used = Math.max(0, (mem.usage || 0) - cache);
  const limit = mem.limit || 0;
  return { used, limit, percent: percent(used, limit) };
}

function statsFor(container) {
  return new Promise((resolve, reject) => {
    container.stats({ stream: false }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// One snapshot of every container: identity, why it is not running, health,
// and resource use for the running ones.
async function collectContainers(docker, { logger = console } = {}) {
  const summaries = await docker.listContainers({ all: true });

  return Promise.all(summaries.map(async summary => {
    const info = {
      id: summary.Id,
      shortId: summary.Id.slice(0, 12),
      name: (summary.Names?.[0] || '').replace(/^\//, '') || 'unknown',
      image: summary.Image,
      labels: summary.Labels || {},
      state: summary.State,
      status: summary.Status,
      health: null,
      exitCode: null,
      restartCount: 0,
      oomKilled: false,
      cpuPercent: null,
      memory: null
    };

    const container = docker.getContainer(summary.Id);

    try {
      const inspected = await container.inspect();
      info.health = inspected.State?.Health?.Status || null;
      info.exitCode = inspected.State?.ExitCode ?? null;
      info.restartCount = inspected.RestartCount || 0;
      info.oomKilled = Boolean(inspected.State?.OOMKilled);
      info.startedAt = inspected.State?.StartedAt || null;
      info.finishedAt = inspected.State?.FinishedAt || null;
    } catch (error) {
      // The container can disappear between listing and inspecting
      logger.error(`[metrics] inspect failed for ${info.name}: ${error.message}`);
    }

    if (summary.State === 'running') {
      try {
        const stats = await statsFor(container);
        info.cpuPercent = containerCpuPercent(stats);
        info.memory = containerMemory(stats);
      } catch (error) {
        logger.error(`[metrics] stats failed for ${info.name}: ${error.message}`);
      }
    }

    return info;
  }));
}

module.exports = {
  createHostCollector,
  collectContainers,
  readMemAvailable,
  containerCpuPercent,
  containerMemory,
  percent
};
