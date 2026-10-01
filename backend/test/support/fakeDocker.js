const crypto = require('crypto');
const { PassThrough } = require('stream');

function randomContainerId() {
  return crypto.randomBytes(32).toString('hex');
}

// One multiplexed Docker log frame: [type, 0, 0, 0, size BE] + payload
function frame(stream, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream === 'stderr' ? 2 : 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function dockerError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.json = { message };
  return error;
}

function notFound(ref) {
  const error = new Error(`No such container: ${ref}`);
  error.statusCode = 404;
  return error;
}

// In-memory stand-in for dockerode. Container references resolve the way the
// Docker daemon resolves them: exact full ID, then exact name, then a unique
// ID prefix. Tests rely on this to reproduce prefix/name confusion bypasses.
function createFakeDocker(specs = []) {
  const containers = specs.map(spec => ({
    id: spec.id || randomContainerId(),
    name: spec.name,
    state: spec.state || 'running',
    labels: spec.labels || {},
    logs: (spec.logs || []).map(entry => (
      typeof entry === 'string' ? { text: entry, stream: 'stdout', time: new Date() } : { stream: 'stdout', time: new Date(), ...entry }
    )),
    followers: new Set()
  }));

  const requestedRefs = [];
  // [{ action, ref }] for every start/stop/restart/remove call
  const actionCalls = [];

  function resolve(ref) {
    if (typeof ref !== 'string' || !ref) return null;
    const byId = containers.find(c => c.id === ref);
    if (byId) return byId;
    const byName = containers.find(c => c.name === ref.replace(/^\//, ''));
    if (byName) return byName;
    const byPrefix = containers.filter(c => c.id.startsWith(ref));
    return byPrefix.length === 1 ? byPrefix[0] : null;
  }

  function render(container, opts) {
    let entries = container.logs;
    if (opts.tail !== undefined && opts.tail !== 'all') {
      entries = entries.slice(-Number(opts.tail));
    }
    return Buffer.concat(entries.map(entry => frame(
      entry.stream,
      `${opts.timestamps ? `${entry.time.toISOString()} ` : ''}${entry.text}\n`
    )));
  }

  const docker = {
    containers,
    requestedRefs,
    actionCalls,

    async listContainers() {
      return containers.map(c => ({
        Id: c.id,
        Names: [`/${c.name}`],
        Image: 'test/image:latest',
        Labels: c.labels,
        State: c.state,
        Status: c.state === 'running' ? 'Up 1 minute' : 'Exited (0) 1 minute ago',
        Created: Math.floor(Date.now() / 1000) - 60,
        Ports: [],
        SizeRw: 0,
        SizeRootFs: 0
      }));
    },

    async info() {
      const running = containers.filter(c => c.state === 'running').length;
      return {
        Containers: containers.length,
        ContainersRunning: running,
        ContainersPaused: 0,
        ContainersStopped: containers.length - running,
        Images: 3,
        ServerVersion: 'test',
        OperatingSystem: 'test-os'
      };
    },

    getContainer(ref) {
      requestedRefs.push(ref);
      return {
        async inspect() {
          const c = resolve(ref);
          if (!c) throw notFound(ref);
          return {
            Id: c.id,
            Name: `/${c.name}`,
            State: { Status: c.state, Running: c.state === 'running', Restarting: false },
            Config: { Labels: c.labels }
          };
        },

        async start() {
          const c = resolve(ref);
          if (!c) throw notFound(ref);
          actionCalls.push({ action: 'start', ref });
          if (c.state === 'running') throw dockerError(304, 'container already started');
          c.state = 'running';
        },

        async stop() {
          const c = resolve(ref);
          if (!c) throw notFound(ref);
          actionCalls.push({ action: 'stop', ref });
          if (c.state !== 'running') throw dockerError(304, 'container already stopped');
          c.state = 'exited';
        },

        async restart() {
          const c = resolve(ref);
          if (!c) throw notFound(ref);
          actionCalls.push({ action: 'restart', ref });
          c.state = 'running';
        },

        async remove(opts = {}) {
          const c = resolve(ref);
          if (!c) throw notFound(ref);
          actionCalls.push({ action: 'remove', ref, opts });
          if (c.state === 'running' && !opts.force) throw dockerError(409, 'cannot remove a running container');
          containers.splice(containers.indexOf(c), 1);
        },

        async logs(opts = {}) {
          const c = resolve(ref);
          if (!c) throw notFound(ref);
          if (!opts.follow) return render(c, opts);

          const stream = new PassThrough();
          stream.write(render(c, opts));
          c.followers.add(stream);
          stream.on('close', () => c.followers.delete(stream));
          return stream;
        },

        stats(opts, callback) {
          callback(null, {
            cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
            precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
            memory_stats: { usage: 1024, limit: 4096 }
          });
        }
      };
    },

    // Append a line to a container's log and push it to live followers
    emitLog(name, text, stream = 'stdout') {
      const c = containers.find(x => x.name === name);
      const entry = { text, stream, time: new Date() };
      c.logs.push(entry);
      for (const follower of c.followers) {
        follower.write(frame(stream, `${entry.time.toISOString()} ${text}\n`));
      }
    },

    followerCount(name) {
      return containers.find(x => x.name === name).followers.size;
    }
  };

  return docker;
}

module.exports = { createFakeDocker, randomContainerId, frame };
