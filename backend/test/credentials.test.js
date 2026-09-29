const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { startTestServer, connectWs, randomPassword } = require('./support/harness');
const { createUserStore } = require('../src/userStore');
const { ensureAdminAccount, fingerprint } = require('../src/bootstrap');
const { ConfigError } = require('../src/config');
const { validatePassword } = require('../src/passwords');

const silentLogger = { warn() {}, error() {}, info() {} };

function tempStore(users) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-bootstrap-'));
  const file = path.join(dir, 'users.json');
  if (users) fs.writeFileSync(file, JSON.stringify({ users }));
  return { store: createUserStore(file), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('admin bootstrap', () => {
  test('fresh install without ADMIN_INITIAL_PASSWORD refuses to start', async () => {
    const { store, cleanup } = tempStore();
    try {
      await assert.rejects(
        ensureAdminAccount(store, { username: 'admin', initialPassword: null }, { logger: silentLogger }),
        ConfigError
      );
    } finally {
      cleanup();
    }
  });

  test('fresh install rejects a weak ADMIN_INITIAL_PASSWORD', async () => {
    const { store, cleanup } = tempStore();
    try {
      await assert.rejects(
        ensureAdminAccount(store, { username: 'admin', initialPassword: 'short' }, { logger: silentLogger }),
        /ADMIN_INITIAL_PASSWORD rejected/
      );
    } finally {
      cleanup();
    }
  });

  test('fresh install creates the admin from the environment with a forced change', async () => {
    const { store, cleanup } = tempStore();
    const initialPassword = randomPassword();
    try {
      const result = await ensureAdminAccount(store, { username: 'admin', initialPassword }, { logger: silentLogger });
      assert.equal(result.created, true);

      const [admin] = store.load().users;
      assert.equal(admin.username, 'admin');
      assert.equal(admin.role, 'admin');
      assert.equal(admin.mustChangePassword, true);
      assert.notEqual(admin.password, initialPassword);
      assert.ok(bcrypt.compareSync(initialPassword, admin.password));
    } finally {
      cleanup();
    }
  });

  test('accounts still using a published seed hash get their password disabled', async () => {
    const seedHash = bcrypt.hashSync(randomPassword(), 4);
    const { store, cleanup } = tempStore([
      { id: '1', username: 'admin', password: seedHash, role: 'admin', allowedContainers: ['*'] },
      { id: '2', username: 'ops', password: bcrypt.hashSync(randomPassword(), 4), role: 'user', allowedContainers: [] }
    ]);
    try {
      const result = await ensureAdminAccount(
        store,
        { username: 'admin', initialPassword: null },
        { logger: silentLogger, seedFingerprints: new Set([fingerprint(seedHash)]) }
      );
      assert.deepEqual(result.disabled, ['admin']);

      const [admin, ops] = store.load().users;
      assert.equal(admin.password, null);
      assert.equal(admin.mustChangePassword, true);
      assert.ok(ops.password, 'unrelated accounts are untouched');
    } finally {
      cleanup();
    }
  });

  test('a disabled admin is re-initialised from ADMIN_INITIAL_PASSWORD', async () => {
    const seedHash = bcrypt.hashSync(randomPassword(), 4);
    const initialPassword = randomPassword();
    const { store, cleanup } = tempStore([
      { id: '1', username: 'admin', password: seedHash, role: 'admin', allowedContainers: ['*'] }
    ]);
    try {
      const result = await ensureAdminAccount(
        store,
        { username: 'admin', initialPassword },
        { logger: silentLogger, seedFingerprints: new Set([fingerprint(seedHash)]) }
      );
      assert.equal(result.reset, true);

      const [admin] = store.load().users;
      assert.ok(bcrypt.compareSync(initialPassword, admin.password));
      assert.equal(admin.mustChangePassword, true);
      assert.equal(admin.id, '1', 'existing account is reused');
    } finally {
      cleanup();
    }
  });

  test('ADMIN_INITIAL_PASSWORD never overrides a working admin password', async () => {
    const existing = randomPassword();
    const { store, cleanup } = tempStore([
      { id: '1', username: 'admin', password: bcrypt.hashSync(existing, 4), role: 'admin', allowedContainers: [] }
    ]);
    try {
      await ensureAdminAccount(store, { username: 'admin', initialPassword: randomPassword() }, { logger: silentLogger });
      const [admin] = store.load().users;
      assert.ok(bcrypt.compareSync(existing, admin.password));
      assert.equal(admin.mustChangePassword, undefined);
    } finally {
      cleanup();
    }
  });

  test('the published seed fingerprint list is not empty', () => {
    const { PUBLISHED_SEED_FINGERPRINTS } = require('../src/bootstrap');
    assert.ok(PUBLISHED_SEED_FINGERPRINTS.size > 0);
  });
});

describe('password policy', () => {
  test('rejects short, username-based and repetitive passwords', () => {
    assert.match(validatePassword('abc'), /at least 12/);
    assert.match(validatePassword('xx-admin-2024-xx', { username: 'admin' }), /username/);
    assert.match(validatePassword('aaaaaaaaaaaaaaaa'), /repetitive/);
    assert.match(validatePassword('ä'.repeat(40)), /72 bytes|repetitive/);
    assert.equal(validatePassword(randomPassword(), { username: 'admin' }), null);
  });
});

describe('forced password change', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({
      users: [
        { username: 'admin', role: 'admin' },
        { username: 'fresh', role: 'user', allowedContainers: ['web'], mustChangePassword: true }
      ],
      containers: [{ name: 'web', logs: ['hello'] }]
    });
  });

  after(() => srv.close());

  test('login returns a restricted token that only allows changing the password', async () => {
    const res = await srv.login('fresh');
    assert.equal(res.status, 200);
    assert.equal(res.body.mustChangePassword, true);
    assert.equal(res.body.user.mustChangePassword, true);

    const token = res.body.token;
    for (const url of ['/api/containers', '/api/docker/info', `/api/containers/${srv.docker.containers[0].id}/logs`]) {
      const blocked = await srv.request('GET', url, { token });
      assert.equal(blocked.status, 403, url);
      assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    }

    const me = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.username, 'fresh');
  });

  test('restricted token cannot open a log stream', async () => {
    const { body } = await srv.login('fresh');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token: body.token });
      const reply = await client.waitFor(m => m.type === 'auth');
      assert.equal(reply.status, 'failed');

      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitFor(m => m.type === 'error' && /Not authenticated/.test(m.message));
    } finally {
      client.close();
    }
  });

  test('change requires the current password and a policy-compliant new one', async () => {
    const { body } = await srv.login('fresh');
    const token = body.token;

    const wrongCurrent = await srv.request('POST', '/api/auth/change-password', {
      token, body: { currentPassword: 'not-the-password', newPassword: randomPassword() }
    });
    assert.equal(wrongCurrent.status, 400);

    const weak = await srv.request('POST', '/api/auth/change-password', {
      token, body: { currentPassword: srv.passwords.fresh, newPassword: 'short' }
    });
    assert.equal(weak.status, 400);

    const same = await srv.request('POST', '/api/auth/change-password', {
      token, body: { currentPassword: srv.passwords.fresh, newPassword: srv.passwords.fresh }
    });
    assert.equal(same.status, 400);
  });

  test('after changing the password the new session works and the flag is cleared', async () => {
    const { body } = await srv.login('fresh');
    const newPassword = randomPassword();

    const changed = await srv.request('POST', '/api/auth/change-password', {
      token: body.token, body: { currentPassword: srv.passwords.fresh, newPassword }
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);

    const list = await srv.request('GET', '/api/containers', { token: changed.body.token });
    assert.equal(list.status, 200);

    assert.equal((await srv.login('fresh', srv.passwords.fresh)).status, 401, 'old password stops working');
    const relogin = await srv.login('fresh', newPassword);
    assert.equal(relogin.status, 200);
    assert.equal(relogin.body.mustChangePassword, undefined);
    srv.passwords.fresh = newPassword;
  });

  test('accounts with a disabled password cannot log in at all', async () => {
    const data = JSON.parse(fs.readFileSync(srv.usersFile, 'utf8'));
    data.users.push({ id: 'locked', username: 'locked', password: null, role: 'admin', allowedContainers: [], mustChangePassword: true });
    fs.writeFileSync(srv.usersFile, JSON.stringify(data));

    for (const guess of ['', 'anything', randomPassword()]) {
      const res = await srv.login('locked', guess);
      assert.ok([400, 401].includes(res.status));
      assert.equal(res.body.token, undefined);
    }
  });

  test('users created by an admin must change their password at first login', async () => {
    const adminToken = await srv.tokenFor('admin');
    const tempPassword = randomPassword();

    const weak = await srv.request('POST', '/api/users', {
      token: adminToken, body: { username: 'newbie', password: 'short', role: 'user', allowedContainers: [] }
    });
    assert.equal(weak.status, 400);

    const created = await srv.request('POST', '/api/users', {
      token: adminToken, body: { username: 'newbie', password: tempPassword, role: 'user', allowedContainers: [] }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.mustChangePassword, true);

    const login = await srv.login('newbie', tempPassword);
    assert.equal(login.body.mustChangePassword, true);
  });

  test('admins cannot change their own password without the current one', async () => {
    const adminToken = await srv.tokenFor('admin');
    const me = (await srv.request('GET', '/api/auth/me', { token: adminToken })).body;
    const res = await srv.request('PUT', `/api/users/${me.id}`, {
      token: adminToken, body: { password: randomPassword() }
    });
    assert.equal(res.status, 400);
  });

  test('password hashes are never returned by the API', async () => {
    const adminToken = await srv.tokenFor('admin');
    const res = await srv.request('GET', '/api/users', { token: adminToken });
    assert.equal(res.status, 200);
    for (const user of res.body) {
      assert.equal(user.password, undefined);
    }
    assert.doesNotMatch(JSON.stringify(res.body), /\$2[aby]\$/);
  });
});
