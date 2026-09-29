const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, randomPassword } = require('./support/harness');

let srv;

beforeEach(async () => {
  srv = await startTestServer({
    users: [
      { username: 'admin', role: 'admin' },
      { username: 'alice', role: 'user', allowedContainers: [] }
    ]
  });
});

afterEach(() => srv.close());

function loginFrom(ip, username, password) {
  return srv.request('POST', '/api/auth/login', {
    headers: { 'X-Forwarded-For': ip },
    body: { username, password }
  });
}

describe('failed login throttling', () => {
  test('five wrong passwords lock that account for that client, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await loginFrom('198.51.100.1', 'admin', `guess-${i}-xxxxxxxx`)).status, 401);
    }
    const locked = await loginFrom('198.51.100.1', 'admin', srv.passwords.admin);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal(locked.body.token, undefined);

    const entry = srv.auditEvents('auth.login').at(-1);
    assert.equal(entry.reason, 'rate_limited');
    assert.equal(entry.ip, '198.51.100.1');
  });

  test('an attacker cannot lock the real user out from another address', async () => {
    for (let i = 0; i < 6; i++) {
      await loginFrom('198.51.100.1', 'admin', `guess-${i}-xxxxxxxx`);
    }
    assert.equal((await loginFrom('192.0.2.50', 'admin', srv.passwords.admin)).status, 200);
  });

  test('one client spraying many usernames is blocked', async () => {
    for (let i = 0; i < 20; i++) {
      await loginFrom('198.51.100.7', `user${i}`, 'spray-password-1');
    }
    assert.equal((await loginFrom('198.51.100.7', 'alice', srv.passwords.alice)).status, 429);
    assert.equal((await loginFrom('198.51.100.8', 'alice', srv.passwords.alice)).status, 200);
  });

  test('the lock expires and a success resets the account counter', async () => {
    for (let i = 0; i < 5; i++) {
      await loginFrom('198.51.100.1', 'alice', `guess-${i}-xxxxxxxx`);
    }
    assert.equal((await loginFrom('198.51.100.1', 'alice', srv.passwords.alice)).status, 429);

    srv.clock.advance(16 * 60 * 1000);
    assert.equal((await loginFrom('198.51.100.1', 'alice', srv.passwords.alice)).status, 200);

    for (let i = 0; i < 4; i++) {
      await loginFrom('198.51.100.1', 'alice', `again-${i}-xxxxxxxx`);
    }
    assert.equal((await loginFrom('198.51.100.1', 'alice', srv.passwords.alice)).status, 200, 'counter was reset');
  });

  test('guessing the current password on change-password is throttled too', async () => {
    const token = await srv.tokenFor('alice');
    for (let i = 0; i < 5; i++) {
      const res = await srv.request('POST', '/api/auth/change-password', {
        token, body: { currentPassword: `guess-${i}-xxxxxxxx`, newPassword: randomPassword() }
      });
      assert.equal(res.status, 400);
    }
    const blocked = await srv.request('POST', '/api/auth/change-password', {
      token, body: { currentPassword: srv.passwords.alice, newPassword: randomPassword() }
    });
    assert.equal(blocked.status, 429);
    assert.equal(srv.auditEvents('auth.password_change').at(-1).reason, 'rate_limited');
  });
});
