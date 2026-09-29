const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const { createApp } = require('../../src/app');
const { createUserStore } = require('../../src/userStore');
const { createTokenService } = require('../../src/tokens');
const { createAuditLogger } = require('../../src/audit');
const { createLoginThrottle } = require('../../src/loginThrottle');
const { createFakeDocker } = require('./fakeDocker');

// Test credentials are generated per run so no secret-looking literal
// ever lands in the repository.
function randomSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64');
}

function randomPassword() {
  return `Pw-${crypto.randomBytes(12).toString('hex')}`;
}

// Lets tests move the server's notion of "now" forward (token expiry etc.)
function createClock() {
  let offsetMs = 0;
  return {
    now: () => Date.now() + offsetMs,
    advance(ms) {
      offsetMs += ms;
    }
  };
}

async function startTestServer({
  users = [],
  containers = [],
  appOptions = {},
  accessTtlSeconds = 15 * 60,
  sessionMaxAgeSeconds = 12 * 60 * 60
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-test-'));
  const usersFile = path.join(dataDir, 'users.json');
  const passwords = {};

  const storedUsers = users.map((u, index) => {
    const password = u.password || randomPassword();
    passwords[u.username] = password;
    return {
      id: u.id || String(index + 1),
      username: u.username,
      password: bcrypt.hashSync(password, 4),
      role: u.role || 'user',
      allowedContainers: u.allowedContainers || [],
      ...(u.mustChangePassword ? { mustChangePassword: true } : {})
    };
  });
  fs.writeFileSync(usersFile, JSON.stringify({ users: storedUsers }, null, 2));

  const docker = createFakeDocker(containers);
  const jwtSecret = randomSecret();
  const clock = createClock();
  const userStore = createUserStore(usersFile);
  const revocationFile = path.join(dataDir, 'revoked-tokens.json');
  const tokens = createTokenService({
    secret: jwtSecret,
    accessTtlSeconds,
    sessionMaxAgeSeconds,
    revocationFile,
    now: clock.now
  });
  const auditEntries = [];
  const audit = createAuditLogger({ stream: { write: line => auditEntries.push(line) } });
  const loginThrottle = createLoginThrottle({ now: clock.now });
  const { server, wss } = createApp({ docker, userStore, tokens, audit, loginThrottle, ...appOptions });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, urlPath, { token, body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  async function login(username, password = passwords[username]) {
    return request('POST', '/api/auth/login', { body: { username, password } });
  }

  async function tokenFor(username) {
    const res = await login(username);
    if (res.status !== 200 || !res.body.token) {
      throw new Error(`login for ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.token;
  }

  // Parsed audit entries, optionally only those for one event name
  function auditEvents(event) {
    const entries = auditEntries.map(line => JSON.parse(line));
    return event ? entries.filter(e => e.event === event) : entries;
  }

  function readUsers() {
    return JSON.parse(fs.readFileSync(usersFile, 'utf8')).users;
  }

  async function close() {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return {
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    docker,
    dataDir,
    usersFile,
    jwtSecret,
    tokens,
    clock,
    revocationFile,
    passwords,
    request,
    login,
    tokenFor,
    readUsers,
    auditEntries,
    auditEvents,
    close
  };
}

// Minimal WebSocket client that records every message so tests can wait for
// (or assert the absence of) specific ones.
function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const waiters = [];
    let closed = false;
    const closeWaiters = [];

    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      for (const waiter of waiters.slice()) {
        if (waiter.predicate(msg)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
      }
    });

    ws.on('close', (code) => {
      closed = true;
      closeWaiters.forEach(fn => fn(code));
    });

    ws.once('error', reject);

    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) {
        ws.send(JSON.stringify(obj));
      },
      // Resolves with the first message (at or after index `from`) matching predicate
      waitFor(predicate, { timeout = 2000, from = 0 } = {}) {
        const existing = messages.slice(from).find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const waiter = {
            predicate,
            resolve: res,
            timer: setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              rej(new Error(`timed out waiting for WebSocket message; received: ${JSON.stringify(messages)}`));
            }, timeout)
          };
          waiters.push(waiter);
        });
      },
      waitForClose(timeout = 2000) {
        if (closed) return Promise.resolve();
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for WebSocket close')), timeout);
          closeWaiters.push(code => { clearTimeout(timer); res(code); });
        });
      },
      get isClosed() {
        return closed;
      },
      close() {
        ws.close();
      }
    }));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startTestServer, connectWs, randomPassword, randomSecret, delay };
