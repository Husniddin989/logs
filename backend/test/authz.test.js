const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { startTestServer, connectWs, randomPassword, randomSecret, delay } = require('./support/harness');
const { canAccessContainer, normalizeAllowedContainers } = require('../src/access');

// Container IDs are chosen so that the old prefix-matching access check
// could be tricked: "ca..." is a unique ID prefix of `secret-db`, and "ca" is
// also a prefix of the name `cafe` that alice is allowed to read.
const WEB_ID = `ab${crypto.randomBytes(31).toString('hex')}`;
const CAFE_ID = `ef${crypto.randomBytes(31).toString('hex')}`;
const SECRET_ID = `ca${crypto.randomBytes(31).toString('hex')}`;
const WEB_SECRET_ID = `dd${crypto.randomBytes(31).toString('hex')}`;

let srv;

before(async () => {
  srv = await startTestServer({
    users: [
      { username: 'admin', role: 'admin' },
      { username: 'alice', role: 'user', allowedContainers: ['web', 'cafe'] },
      { username: 'bob', role: 'user', allowedContainers: [] },
      { username: 'legacy', role: 'user', allowedContainers: ['*'] }
    ],
    containers: [
      { id: WEB_ID, name: 'web', logs: ['web says hi'] },
      { id: CAFE_ID, name: 'cafe', logs: ['cafe log'] },
      { id: SECRET_ID, name: 'secret-db', logs: ['DB_PASSWORD=do-not-leak'] },
      { id: WEB_SECRET_ID, name: 'web-secret', logs: ['web-secret log'], state: 'exited' }
    ],
    appOptions: { wsRevalidateIntervalMs: 100 }
  });
});

after(() => srv.close());

function logsUrl(ref) {
  return `/api/containers/${ref}/logs?tail=100`;
}

describe('(a) requests without a valid token get 401', () => {
  const protectedRoutes = [
    ['GET', '/api/containers'],
    ['GET', `/api/containers/${WEB_ID}/logs`],
    ['GET', '/api/docker/info'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/change-password'],
    ['GET', '/api/users'],
    ['POST', '/api/users'],
    ['PUT', '/api/users/1'],
    ['DELETE', '/api/users/1']
  ];

  for (const [method, url] of protectedRoutes) {
    test(`${method} ${url} without Authorization header`, async () => {
      const res = await srv.request(method, url, { body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401);
    });
  }

  test('malformed, foreign-signed, unsigned and expired tokens are rejected', async () => {
    const claims = { userId: '1', username: 'admin', role: 'admin' };
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const badTokens = [
      'garbage',
      jwt.sign(claims, randomSecret()),
      `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`,
      `${jwt.sign(claims, srv.jwtSecret).split('.').slice(0, 2).join('.')}.`,
      jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, srv.jwtSecret)
    ];
    for (const token of badTokens) {
      const res = await srv.request('GET', '/api/containers', { token });
      assert.equal(res.status, 401, `token accepted: ${token}`);
    }

    const basic = await srv.request('GET', '/api/containers', { headers: { Authorization: 'Basic YWRtaW46eA==' } });
    assert.equal(basic.status, 401);
  });

  test('a token for a deleted user stops working', async () => {
    const data = JSON.parse(fs.readFileSync(srv.usersFile, 'utf8'));
    data.users.push({ id: 'temp', username: 'temp', password: null, role: 'admin', allowedContainers: [] });
    fs.writeFileSync(srv.usersFile, JSON.stringify(data));
    const token = jwt.sign({ userId: 'temp', username: 'temp', role: 'admin' }, srv.jwtSecret);

    data.users = data.users.filter(u => u.id !== 'temp');
    fs.writeFileSync(srv.usersFile, JSON.stringify(data));
    assert.equal((await srv.request('GET', '/api/containers', { token })).status, 401);
  });

  test('WebSocket: subscribing without auth streams nothing', async () => {
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'subscribe', containerId: WEB_ID });
      await client.waitFor(m => m.type === 'error' && m.message === 'Not authenticated');

      client.send({ action: 'auth', token: jwt.sign({ userId: '1' }, randomSecret()) });
      const reply = await client.waitFor(m => m.type === 'auth');
      assert.equal(reply.status, 'failed');

      client.send({ action: 'subscribe', containerId: WEB_ID });
      await delay(150);
      assert.equal(client.messages.filter(m => m.type === 'log').length, 0);
    } finally {
      client.close();
    }
  });
});

describe('(b) users cannot read containers they were not granted', () => {
  test('REST: allowed container is readable by full ID and by name', async () => {
    const token = await srv.tokenFor('alice');
    for (const ref of [WEB_ID, 'web']) {
      const res = await srv.request('GET', logsUrl(ref), { token });
      assert.equal(res.status, 200, ref);
      assert.deepEqual(res.body.logs.map(l => l.message), ['web says hi']);
    }
  });

  test('REST: other containers are denied however they are referenced', async () => {
    const token = await srv.tokenFor('alice');
    const refs = [
      SECRET_ID, // full ID
      'secret-db', // name
      SECRET_ID.slice(0, 12), // short ID
      'ca', // unique ID prefix that is also a prefix of the allowed name "cafe"
      'web-secret', // name that starts with the allowed name "web"
      WEB_SECRET_ID.slice(0, 12)
    ];
    for (const ref of refs) {
      const res = await srv.request('GET', logsUrl(ref), { token });
      assert.equal(res.status, 403, `alice read ${ref}`);
      assert.doesNotMatch(JSON.stringify(res.body), /do-not-leak|web-secret log/);
    }
  });

  test('REST: missing and forbidden containers look the same to non-admins', async () => {
    const token = await srv.tokenFor('alice');
    const missing = await srv.request('GET', logsUrl('does-not-exist'), { token });
    const forbidden = await srv.request('GET', logsUrl('secret-db'), { token });
    assert.equal(missing.status, forbidden.status);
    assert.deepEqual(missing.body, forbidden.body);
  });

  test('REST: logs are fetched by canonical ID, never by the client reference', async () => {
    const token = await srv.tokenFor('alice');
    srv.docker.requestedRefs.length = 0;
    await srv.request('GET', logsUrl('web'), { token });
    // inspect() may see the raw reference; everything after it must use the full ID
    assert.deepEqual(srv.docker.requestedRefs, ['web', WEB_ID]);
  });

  test('REST: malformed container references are rejected before reaching Docker', async () => {
    const token = await srv.tokenFor('admin');
    srv.docker.requestedRefs.length = 0;
    for (const ref of ['..%2F..%2Finfo', '%2Fsecret-db', '.hidden', '-flag', 'a%20b']) {
      const res = await srv.request('GET', logsUrl(ref), { token });
      assert.equal(res.status, 400, ref);
    }
    assert.deepEqual(srv.docker.requestedRefs, []);
  });

  test('REST: container list and Docker info only cover granted containers', async () => {
    const token = await srv.tokenFor('alice');
    const list = await srv.request('GET', '/api/containers', { token });
    assert.deepEqual(list.body.map(c => c.name).sort(), ['cafe', 'web']);

    const info = await srv.request('GET', '/api/docker/info', { token });
    assert.equal(info.body.containers, 2);
    assert.equal(info.body.containersRunning, 2);
    assert.equal(info.body.serverVersion, undefined);
    assert.equal(info.body.operatingSystem, undefined);

    const bobList = await srv.request('GET', '/api/containers', { token: await srv.tokenFor('bob') });
    assert.deepEqual(bobList.body, []);
  });

  test('REST: a stored "*" grant gives a regular user nothing', async () => {
    const token = await srv.tokenFor('legacy');
    const list = await srv.request('GET', '/api/containers', { token });
    assert.deepEqual(list.body, []);
    assert.equal((await srv.request('GET', logsUrl('web'), { token })).status, 403);
  });

  test('WebSocket: subscribing to a foreign container is refused', async () => {
    const token = await srv.tokenFor('alice');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');

      for (const ref of [SECRET_ID, 'secret-db', 'ca', 'web-secret', '../../info']) {
        const from = client.messages.length;
        client.send({ action: 'subscribe', containerId: ref });
        const reply = await client.waitFor(m => m.type === 'error', { from });
        assert.match(reply.message, /Access denied|Invalid container/, ref);
      }

      srv.docker.emitLog('secret-db', 'another secret');
      await delay(100);
      assert.equal(client.messages.filter(m => m.type === 'log').length, 0);
      assert.equal(srv.docker.followerCount('secret-db'), 0);
    } finally {
      client.close();
    }
  });

  test('WebSocket: an allowed stream stops when the grant is revoked', async () => {
    const token = await srv.tokenFor('alice');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      client.send({ action: 'subscribe', containerId: 'cafe' });
      await client.waitFor(m => m.type === 'log' && m.data.message === 'cafe log');

      const adminToken = await srv.tokenFor('admin');
      const alice = srv.readUsers().find(u => u.username === 'alice');
      const update = await srv.request('PUT', `/api/users/${alice.id}`, {
        token: adminToken, body: { allowedContainers: ['web'] }
      });
      assert.equal(update.status, 200);

      await client.waitFor(m => m.code === 'ACCESS_REVOKED', { timeout: 1000 });
      assert.equal(srv.docker.followerCount('cafe'), 0);

      const from = client.messages.length;
      srv.docker.emitLog('cafe', 'after revoke');
      await delay(100);
      assert.equal(client.messages.slice(from).filter(m => m.type === 'log').length, 0);
    } finally {
      client.close();
      await srv.request('PUT', `/api/users/${srv.readUsers().find(u => u.username === 'alice').id}`, {
        token: await srv.tokenFor('admin'), body: { allowedContainers: ['web', 'cafe'] }
      });
    }
  });

  test('WebSocket: deleting the user ends the session', async () => {
    const adminToken = await srv.tokenFor('admin');
    const password = randomPassword();
    const created = await srv.request('POST', '/api/users', {
      token: adminToken, body: { username: 'shortlived', password, role: 'user', allowedContainers: ['web'] }
    });
    // Skip the forced password change by clearing the flag directly
    const data = JSON.parse(fs.readFileSync(srv.usersFile, 'utf8'));
    data.users.find(u => u.id === created.body.id).mustChangePassword = false;
    fs.writeFileSync(srv.usersFile, JSON.stringify(data));

    const token = (await srv.login('shortlived', password)).body.token;
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitFor(m => m.type === 'log');

      await srv.request('DELETE', `/api/users/${created.body.id}`, { token: adminToken });
      await client.waitFor(m => m.type === 'auth' && m.status === 'failed', { timeout: 1000 });
      await client.waitForClose();
    } finally {
      client.close();
    }
  });

  test('WebSocket: an open socket cannot be re-authenticated as someone else', async () => {
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token: await srv.tokenFor('alice') });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      const from = client.messages.length;
      client.send({ action: 'auth', token: await srv.tokenFor('bob') });
      const reply = await client.waitFor(m => m.type === 'auth', { from });
      assert.equal(reply.status, 'failed');
      await client.waitForClose();
    } finally {
      client.close();
    }
  });

  test('WebSocket: sockets that never authenticate are closed', async () => {
    const quick = await startTestServer({ appOptions: { wsAuthTimeoutMs: 100 } });
    try {
      const client = await connectWs(quick.wsUrl);
      assert.equal(await client.waitForClose(1000), 4401);
    } finally {
      await quick.close();
    }
  });
});

describe('(c) non-admins cannot use user management', () => {
  test('every /api/users route answers 403 and changes nothing', async () => {
    const before = fs.readFileSync(srv.usersFile, 'utf8');
    const admin = srv.readUsers().find(u => u.username === 'admin');

    for (const username of ['alice', 'bob']) {
      const token = await srv.tokenFor(username);
      const calls = [
        ['GET', '/api/users'],
        ['POST', '/api/users', { username: 'mallory', password: randomPassword(), role: 'admin' }],
        ['PUT', `/api/users/${admin.id}`, { role: 'user' }],
        ['PUT', `/api/users/${srv.readUsers().find(u => u.username === username).id}`, { role: 'admin', allowedContainers: ['*'] }],
        ['DELETE', `/api/users/${admin.id}`]
      ];
      for (const [method, url, body] of calls) {
        const res = await srv.request(method, url, { token, body });
        assert.equal(res.status, 403, `${username} ${method} ${url}`);
      }
    }

    assert.equal(fs.readFileSync(srv.usersFile, 'utf8'), before);
  });
});

describe('user management input validation', () => {
  test('"*" can only be granted to admins', async () => {
    const token = await srv.tokenFor('admin');
    const res = await srv.request('POST', '/api/users', {
      token, body: { username: 'wild', password: randomPassword(), role: 'user', allowedContainers: ['*'] }
    });
    assert.equal(res.status, 400);

    const alice = srv.readUsers().find(u => u.username === 'alice');
    const update = await srv.request('PUT', `/api/users/${alice.id}`, { token, body: { allowedContainers: ['web', '*'] } });
    assert.equal(update.status, 400);
  });

  test('unknown roles, bad usernames and bad grants are rejected', async () => {
    const token = await srv.tokenFor('admin');
    const cases = [
      { username: 'x1', password: randomPassword(), role: 'superadmin' },
      { username: 'has space', password: randomPassword() },
      { username: 'ok-name', password: randomPassword(), allowedContainers: 'web' },
      { username: 'ok-name', password: randomPassword(), allowedContainers: ['../etc'] }
    ];
    for (const body of cases) {
      assert.equal((await srv.request('POST', '/api/users', { token, body })).status, 400, JSON.stringify(body));
    }
  });

  test('the last admin cannot be demoted and usernames stay unique', async () => {
    const token = await srv.tokenFor('admin');
    const admin = srv.readUsers().find(u => u.username === 'admin');
    assert.equal((await srv.request('PUT', `/api/users/${admin.id}`, { token, body: { role: 'user' } })).status, 400);

    const bob = srv.readUsers().find(u => u.username === 'bob');
    assert.equal((await srv.request('PUT', `/api/users/${bob.id}`, { token, body: { username: 'alice' } })).status, 400);
  });
});

describe('access rules', () => {
  const container = { id: `${'a'.repeat(12)}${'0'.repeat(52)}`, name: 'api' };

  test('match exact name, exact ID or a 12+ char ID prefix only', () => {
    const allow = (entries) => canAccessContainer({ role: 'user', allowedContainers: entries }, container);
    assert.equal(allow(['api']), true);
    assert.equal(allow([container.id]), true);
    assert.equal(allow([container.id.slice(0, 12)]), true);
    assert.equal(allow([container.id.slice(0, 11)]), false);
    assert.equal(allow(['ap']), false);
    assert.equal(allow(['api-v2']), false);
    assert.equal(allow(['*']), false);
    assert.equal(allow([]), false);
    assert.equal(canAccessContainer({ role: 'admin', allowedContainers: [] }, container), true);
  });

  test('grant normalisation drops duplicates and leading slashes', () => {
    assert.deepEqual(normalizeAllowedContainers(['/web', 'web', 'db'], 'user').value, ['web', 'db']);
    assert.deepEqual(normalizeAllowedContainers(['*'], 'admin').value, []);
  });
});
