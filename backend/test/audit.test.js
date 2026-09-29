const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer, connectWs, randomPassword } = require('./support/harness');
const { createAuditLogger } = require('../src/audit');

const CLIENT_IP = '203.0.113.9';

let srv;
const issuedTokens = [];

before(async () => {
  srv = await startTestServer({
    users: [
      { username: 'admin', role: 'admin' },
      { username: 'alice', role: 'user', allowedContainers: ['web'] }
    ],
    containers: [{ name: 'web', logs: ['hello'] }, { name: 'db', logs: ['secret'] }]
  });
});

after(() => srv.close());

async function tokenFor(username) {
  const token = await srv.tokenFor(username);
  issuedTokens.push(token);
  return token;
}

function last(event) {
  return srv.auditEvents(event).at(-1);
}

describe('authentication events', () => {
  test('failed and successful logins are recorded with the client IP', async () => {
    const headers = { 'X-Forwarded-For': CLIENT_IP, 'User-Agent': 'audit-test' };

    await srv.request('POST', '/api/auth/login', { headers, body: { username: 'alice', password: 'wrong-password-1' } });
    let entry = last('auth.login');
    assert.equal(entry.outcome, 'failure');
    assert.equal(entry.reason, 'bad_password');
    assert.equal(entry.username, 'alice');
    assert.equal(entry.ip, CLIENT_IP);
    assert.equal(entry.userAgent, 'audit-test');
    assert.equal(entry.type, 'audit');
    assert.ok(Date.parse(entry.ts));

    await srv.request('POST', '/api/auth/login', { headers, body: { username: 'nobody', password: 'whatever-123' } });
    assert.equal(last('auth.login').reason, 'unknown_user');

    await srv.request('POST', '/api/auth/login', { headers, body: {} });
    assert.equal(last('auth.login').reason, 'missing_fields');

    const ok = await srv.request('POST', '/api/auth/login', {
      headers, body: { username: 'alice', password: srv.passwords.alice }
    });
    issuedTokens.push(ok.body.token);
    entry = last('auth.login');
    assert.equal(entry.outcome, 'success');
    assert.equal(entry.actor.username, 'alice');
  });

  test('the client IP is the first untrusted hop, not a spoofed header value', async () => {
    await srv.request('POST', '/api/auth/login', {
      headers: { 'X-Forwarded-For': `10.0.0.66, ${CLIENT_IP}, 172.18.0.1` },
      body: { username: 'alice', password: 'wrong-password-2' }
    });
    assert.equal(last('auth.login').ip, CLIENT_IP);
  });

  test('rejected tokens are recorded with the reason', async () => {
    await srv.request('GET', '/api/containers');
    assert.equal(last('auth.token_rejected').reason, 'missing');

    await srv.request('GET', '/api/containers', { token: 'not-a-token' });
    assert.equal(last('auth.token_rejected').reason, 'invalid');

    const token = await tokenFor('alice');
    await srv.request('POST', '/api/auth/logout', { token });
    assert.equal(last('auth.logout').actor.username, 'alice');
    await srv.request('GET', '/api/containers', { token });
    const entry = last('auth.token_rejected');
    assert.equal(entry.reason, 'revoked');
    assert.equal(entry.path, '/api/containers');
  });

  test('password changes are recorded without the passwords', async () => {
    const token = await tokenFor('alice');
    await srv.request('POST', '/api/auth/change-password', {
      token, body: { currentPassword: 'wrong-password-3', newPassword: randomPassword() }
    });
    assert.equal(last('auth.password_change').reason, 'bad_current_password');

    const newPassword = randomPassword();
    const res = await srv.request('POST', '/api/auth/change-password', {
      token, body: { currentPassword: srv.passwords.alice, newPassword }
    });
    issuedTokens.push(res.body.token);
    srv.passwords.alice = newPassword;
    assert.equal(last('auth.password_change').outcome, 'success');
  });
});

describe('access and admin events', () => {
  test('denied container and admin access is recorded', async () => {
    const token = await tokenFor('alice');

    await srv.request('GET', '/api/containers/db/logs', { token });
    let entry = last('access.denied');
    assert.equal(entry.reason, 'container_not_granted');
    assert.equal(entry.containerRef, 'db');
    assert.equal(entry.actor.username, 'alice');

    await srv.request('GET', '/api/containers/..%2Fetc/logs', { token });
    assert.equal(last('access.denied').reason, 'invalid_container_ref');

    await srv.request('GET', '/api/users', { token });
    entry = last('access.denied');
    assert.equal(entry.reason, 'admin_required');
    assert.equal(entry.path, '/api/users');

    await srv.request('GET', '/api/containers/web/logs', { token });
    entry = last('logs.access');
    assert.equal(entry.channel, 'rest');
    assert.equal(entry.container.name, 'web');
  });

  test('admin actions record actor, target and what changed', async () => {
    const adminToken = await tokenFor('admin');
    const temp = randomPassword();

    const created = await srv.request('POST', '/api/users', {
      token: adminToken, body: { username: 'bob', password: temp, role: 'user', allowedContainers: ['web'] }
    });
    let entry = last('admin.user_create');
    assert.equal(entry.actor.username, 'admin');
    assert.equal(entry.target.username, 'bob');
    assert.deepEqual(entry.allowedContainers, ['web']);

    await srv.request('PUT', `/api/users/${created.body.id}`, {
      token: adminToken, body: { role: 'user', allowedContainers: ['web', 'db'], password: randomPassword() }
    });
    entry = last('admin.user_update');
    assert.deepEqual(entry.changes.allowedContainers, { from: ['web'], to: ['web', 'db'] });
    assert.equal(entry.changes.passwordReset, true);
    assert.equal(entry.changes.role, undefined, 'unchanged fields are not listed');

    await srv.request('POST', `/api/users/${created.body.id}/revoke-sessions`, { token: adminToken });
    assert.equal(last('admin.revoke_sessions').target.username, 'bob');

    await srv.request('DELETE', `/api/users/${created.body.id}`, { token: adminToken });
    assert.equal(last('admin.user_delete').target.username, 'bob');
  });

  test('WebSocket authentication, access and session end are recorded', async () => {
    const token = await tokenFor('alice');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token: 'bogus' });
      await client.waitFor(m => m.type === 'auth');
      assert.equal(last('ws.auth').outcome, 'failure');

      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      assert.equal(last('ws.auth').actor.username, 'alice');

      client.send({ action: 'subscribe', containerId: 'db' });
      await client.waitFor(m => m.type === 'error');
      const denied = last('access.denied');
      assert.equal(denied.channel, 'ws');
      assert.equal(denied.containerRef, 'db');

      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitFor(m => m.type === 'log');
      assert.equal(last('logs.access').channel, 'ws');

      await srv.request('POST', '/api/auth/logout-all', { token });
      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitForClose();
      const ended = last('ws.session_ended');
      assert.equal(ended.reason, 'token_version');
      assert.equal(ended.actor.username, 'alice');
    } finally {
      client.close();
    }
  });
});

describe('audit log hygiene', () => {
  test('no password, token or hash ever reaches the audit log', () => {
    const log = srv.auditEntries.join('');
    assert.ok(srv.auditEntries.length > 20, 'the other tests produced entries');
    for (const secret of [...Object.values(srv.passwords), ...issuedTokens]) {
      assert.equal(log.includes(secret), false);
    }
    assert.doesNotMatch(log, /\$2[aby]\$/);
    assert.doesNotMatch(log, /wrong-password-/);
  });

  test('entries are single lines and long values are truncated', () => {
    const lines = [];
    const audit = createAuditLogger({ stream: { write: line => lines.push(line) } });
    audit.log('auth.login', { username: 'evil\n{"event":"forged"}', userAgent: 'x'.repeat(5000) });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].split('\n').length, 2); // content + trailing newline
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, 'auth.login');
    assert.ok(entry.userAgent.length <= 201);
  });

  test('the audit file is appended to and not world-readable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-audit-'));
    const file = path.join(dir, 'nested', 'audit.log');
    try {
      const audit = createAuditLogger({ file, stream: { write() {} } });
      audit.log('auth.login', { outcome: 'success' });
      audit.log('auth.logout', { outcome: 'success' });

      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.deepEqual(lines.map(l => l.event), ['auth.login', 'auth.logout']);
      assert.equal(fs.statSync(file).mode & 0o077, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
