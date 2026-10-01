const net = require('net');
const { Client } = require('pg');

const DEFAULT_PORTS = { postgres: 5432, redis: 6379 };
const SERVICE_LABELS = { postgres: 'Postgres', redis: 'Redis' };

// Error text goes to Telegram and the admin UI: keep it short and make sure
// the password can never appear in it
function cleanError(error, password) {
  let message = String(error?.code && !error.message ? error.code : error?.message || error || 'unknown error');
  if (password) message = message.split(password).join('<password>');
  message = message.replace(/\s+/g, ' ').trim();
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

// Connects, runs one cheap query and disconnects. Connection usage against
// max_connections is what usually runs out first on a busy database.
async function probePostgres(service, { timeoutMs = 5000, ClientImpl = Client } = {}) {
  const started = Date.now();
  const client = new ClientImpl({
    host: service.host,
    port: service.port || DEFAULT_PORTS.postgres,
    user: service.user || 'postgres',
    password: service.password || undefined,
    database: service.database || undefined,
    ssl: service.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    application_name: 'docker-log-viewer-alerts'
  });
  // A connection dropped after the probe finished must not crash the process
  client.on('error', () => {});

  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE datname IS NOT NULL)::int AS connections,
        current_setting('max_connections')::int AS max_connections,
        pg_database_size(current_database())::bigint AS size_bytes,
        current_setting('server_version') AS version
    `);
    const row = rows[0] || {};
    return {
      ok: true,
      latencyMs: Date.now() - started,
      connections: Number(row.connections),
      maxConnections: Number(row.max_connections),
      sizeBytes: Number(row.size_bytes),
      version: row.version || null
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: cleanError(error, service.password) };
  } finally {
    client.end().catch(() => {});
  }
}

function encodeCommand(args) {
  return `*${args.length}\r\n${args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
}

// Reads one RESP reply from buf at offset. Returns { value, error, next } or
// null when the reply is not complete yet. Only the reply types the probe
// receives (simple string, error, integer, bulk string) are supported.
function parseReply(buf, offset = 0) {
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const type = String.fromCharCode(buf[offset]);
  const line = buf.toString('utf8', offset + 1, lineEnd);

  if (type === '+') return { value: line, next: lineEnd + 2 };
  if (type === '-') return { error: line, next: lineEnd + 2 };
  if (type === ':') return { value: Number(line), next: lineEnd + 2 };
  if (type === '$') {
    const length = Number(line);
    if (length < 0) return { value: null, next: lineEnd + 2 };
    const start = lineEnd + 2;
    if (buf.length < start + length + 2) return null;
    return { value: buf.toString('utf8', start, start + length), next: start + length + 2 };
  }
  throw new Error(`unexpected Redis reply type "${type}"`);
}

function parseInfo(text) {
  const info = {};
  for (const line of String(text || '').split('\r\n')) {
    const index = line.indexOf(':');
    if (index > 0 && !line.startsWith('#')) info[line.slice(0, index)] = line.slice(index + 1);
  }
  return info;
}

// AUTH (when a password is set), PING and INFO over a plain TCP connection
function probeRedis(service, { timeoutMs = 5000, connect = net.createConnection } = {}) {
  const started = Date.now();
  const commands = [];
  if (service.password) {
    commands.push(service.user ? ['AUTH', service.user, service.password] : ['AUTH', service.password]);
  }
  commands.push(['PING'], ['INFO']);

  return new Promise(resolve => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const replies = [];

    const socket = connect({ host: service.host, port: service.port || DEFAULT_PORTS.redis });

    function finish(result) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ latencyMs: Date.now() - started, ...result });
    }

    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `${timeoutMs} ms ichida javob bermadi` }));
    socket.on('error', error => finish({ ok: false, error: cleanError(error, service.password) }));
    socket.on('close', () => finish({ ok: false, error: 'ulanish yopildi' }));
    socket.on('connect', () => socket.write(commands.map(encodeCommand).join('')));

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        let reply;
        while (replies.length < commands.length && (reply = parseReply(buffer))) {
          buffer = buffer.subarray(reply.next);
          if (reply.error) {
            finish({ ok: false, error: cleanError(reply.error, service.password) });
            return;
          }
          replies.push(reply.value);
        }
      } catch (error) {
        finish({ ok: false, error: cleanError(error, service.password) });
        return;
      }
      if (replies.length < commands.length) return;

      const info = parseInfo(replies.at(-1));
      finish({
        ok: true,
        usedMemory: Number(info.used_memory) || 0,
        maxMemory: Number(info.maxmemory) || 0,
        clients: Number(info.connected_clients) || 0,
        version: info.redis_version || null
      });
    });
  });
}

const PROBES = { postgres: probePostgres, redis: probeRedis };

// One probe of one configured service; never throws
async function probeService(service, options = {}) {
  const base = {
    id: service.id,
    type: service.type,
    name: service.name,
    target: `${service.host}:${service.port || DEFAULT_PORTS[service.type]}`
  };
  const probe = PROBES[service.type];
  if (!probe) return { ...base, ok: false, error: `unknown service type ${service.type}` };
  try {
    return { ...base, ...(await probe(service, options)) };
  } catch (error) {
    return { ...base, ok: false, error: cleanError(error, service.password) };
  }
}

module.exports = {
  probeService,
  probePostgres,
  probeRedis,
  parseReply,
  parseInfo,
  encodeCommand,
  DEFAULT_PORTS,
  SERVICE_LABELS
};
