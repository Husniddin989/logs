const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { startTestServer, connectWs, randomPassword, randomSecret, delay } = require('./support/harness');
const { loadConfig, parseDuration, ConfigError } = require('../src/config');
const { createTokenService } = require('../src/tokens');

const decode = (token) => jwt.decode(token);

describe('JWT configuration', () => {
  const base = { ADMIN_INITIAL_PASSWORD: '' };

  test('JWT_SECRET is required and has no default', () => {
    assert.throws(() => loadConfig({ ...base }), ConfigError);
    assert.throws(() => loadConfig({ ...base, JWT_SECRET: '' }), /required/);
  });

  test('short, repetitive and published secrets are refused', () => {
    assert.throws(() => loadConfig({ ...base, JWT_SECRET: 'too-short' }), /at least 32/);
    assert.throws(() => loadConfig({ ...base, JWT_SECRET: 'ab'.repeat(32) }), /not random enough/);
    // Previously published defaults are recognised by fingerprint; rebuild one
    // from its parts so the literal never appears in the repository.
    const published = ['docker', 'log', 'viewer', 'secret', 'change', 'me'].join('-');
    assert.throws(() => loadConfig({ ...base, JWT_SECRET: published }), /published/);
  });

  test('a random secret and default lifetimes are accepted', () => {
    const config = loadConfig({ ...base, JWT_SECRET: randomSecret() });
    assert.equal(config.jwt.accessTtlSeconds, 15 * 60);
    assert.equal(config.jwt.sessionMaxAgeSeconds, 12 * 60 * 60);
  });

  test('durations parse and are sanity-checked', () => {
    assert.equal(parseDuration('900', 'X'), 900);
    assert.equal(parseDuration('15m', 'X'), 900);
    assert.equal(parseDuration('2h', 'X'), 7200);
    assert.equal(parseDuration('7d', 'X'), 604800);
    assert.throws(() => parseDuration('soon', 'X'), ConfigError);
    assert.throws(() => parseDuration('0', 'X'), ConfigError);
    assert.throws(
      () => loadConfig({ ...base, JWT_SECRET: randomSecret(), JWT_ACCESS_TTL: '2d', SESSION_MAX_AGE: '1d' }),
      /must not exceed/
    );
  });
});

describe('token verification', () => {
  const secret = randomSecret();
  const service = createTokenService({ secret, accessTtlSeconds: 900, sessionMaxAgeSeconds: 3600 });
  const user = { id: 'u1', username: 'alice', role: 'user' };

  test('issued tokens are HS256 with issuer, audience, jti and a short lifetime', () => {
    const token = service.issueSession(user);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
    const claims = decode(token);
    assert.equal(header.alg, 'HS256');
    assert.equal(claims.iss, 'docker-log-viewer');
    assert.equal(claims.aud, 'docker-log-viewer');
    assert.equal(claims.sub, 'u1');
    assert.equal(claims.ver, 0);
    assert.match(claims.jti, /^[0-9a-f-]{36}$/);
    assert.equal(claims.exp - claims.iat, 900);
    assert.deepEqual(service.verify(token).sub, 'u1');
  });

  test('other algorithms, issuers, audiences and claim shapes are rejected', () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = { sub: 'u1', ver: 0, auth_time: now, jti: crypto.randomUUID() };
    const forged = [
      jwt.sign(valid, secret, { algorithm: 'HS512', issuer: 'docker-log-viewer', audience: 'docker-log-viewer', expiresIn: 60 }),
      jwt.sign(valid, secret, { issuer: 'someone-else', audience: 'docker-log-viewer', expiresIn: 60 }),
      jwt.sign(valid, secret, { issuer: 'docker-log-viewer', audience: 'other-app', expiresIn: 60 }),
      jwt.sign({ ...valid, ver: undefined }, secret, { issuer: 'docker-log-viewer', audience: 'docker-log-viewer', expiresIn: 60 }),
      jwt.sign({ userId: 'u1' }, secret, { expiresIn: 60 }) // pre-hardening token format
    ];
    for (const token of forged) {
      assert.throws(() => service.verify(token), { reason: 'invalid' });
    }
  });

  test('tokens never outlive the absolute session limit', () => {
    const longTtl = createTokenService({ secret, accessTtlSeconds: 3000, sessionMaxAgeSeconds: 3600 });
    const authTime = Math.floor(Date.now() / 1000) - 3000;
    const claims = decode(longTtl.issueSession(user, { authTime }));
    assert.equal(claims.exp, authTime + 3600);
    assert.throws(() => longTtl.issueSession(user, { authTime: authTime - 600 }), { reason: 'session_expired' });
  });
});

describe('sessions over HTTP', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({
      users: [
        { username: 'admin', role: 'admin' },
        { username: 'alice', role: 'user', allowedContainers: ['web'] }
      ],
      containers: [{ name: 'web', logs: ['hello'] }],
      accessTtlSeconds: 15 * 60,
      sessionMaxAgeSeconds: 60 * 60,
      appOptions: { wsRevalidateIntervalMs: 50 }
    });
  });

  after(() => srv.close());

  test('an access token expires after its TTL', async () => {
    const token = await srv.tokenFor('alice');
    srv.clock.advance(16 * 60 * 1000);
    assert.equal((await srv.request('GET', '/api/containers', { token })).status, 401);
  });

  test('refresh issues a new token but keeps the original login time', async () => {
    const token = await srv.tokenFor('alice');
    srv.clock.advance(10 * 60 * 1000);

    const refreshed = await srv.request('POST', '/api/auth/refresh', { token });
    assert.equal(refreshed.status, 200);
    const before = decode(token);
    const after = decode(refreshed.body.token);
    assert.notEqual(after.jti, before.jti);
    assert.equal(after.auth_time, before.auth_time);
    assert.ok(after.exp > before.exp);
    assert.equal(refreshed.body.user.username, 'alice');

    srv.clock.advance(10 * 60 * 1000);
    assert.equal((await srv.request('GET', '/api/containers', { token })).status, 401, 'old token expired');
    assert.equal((await srv.request('GET', '/api/containers', { token: refreshed.body.token })).status, 200);
  });

  test('sliding refresh stops at SESSION_MAX_AGE', async () => {
    let token = await srv.tokenFor('alice');
    for (let i = 0; i < 4; i++) {
      srv.clock.advance(14 * 60 * 1000);
      const res = await srv.request('POST', '/api/auth/refresh', { token });
      if (res.status !== 200) {
        assert.equal(res.status, 401);
        return;
      }
      token = res.body.token;
      assert.ok(decode(token).exp <= decode(token).auth_time + 60 * 60);
    }
    srv.clock.advance(14 * 60 * 1000);
    assert.equal((await srv.request('POST', '/api/auth/refresh', { token })).status, 401);
  });

  test('a password-change token cannot be refreshed into a session', async () => {
    const token = srv.tokens.issuePasswordChange(srv.readUsers().find(u => u.username === 'alice'));
    assert.equal((await srv.request('POST', '/api/auth/refresh', { token })).status, 403);
  });

  test('logout revokes exactly that token, also after a restart', async () => {
    const token = await srv.tokenFor('alice');
    const other = await srv.tokenFor('alice');

    assert.equal((await srv.request('POST', '/api/auth/logout', { token })).status, 204);
    assert.equal((await srv.request('GET', '/api/containers', { token })).status, 401);
    assert.equal((await srv.request('GET', '/api/containers', { token: other })).status, 200);

    const restarted = createTokenService({
      secret: srv.jwtSecret, accessTtlSeconds: 900, sessionMaxAgeSeconds: 3600,
      revocationFile: srv.revocationFile, now: srv.clock.now
    });
    assert.throws(() => restarted.verify(token), { reason: 'revoked' });
    assert.equal(restarted.verify(other).sub, decode(other).sub);
  });

  test('logout-all revokes every token of the user', async () => {
    const a = await srv.tokenFor('alice');
    const b = await srv.tokenFor('alice');
    const adminToken = await srv.tokenFor('admin');

    assert.equal((await srv.request('POST', '/api/auth/logout-all', { token: a })).status, 204);
    for (const token of [a, b]) {
      assert.equal((await srv.request('GET', '/api/containers', { token })).status, 401);
    }
    assert.equal((await srv.request('GET', '/api/containers', { token: adminToken })).status, 200, 'other users unaffected');
    assert.equal((await srv.request('GET', '/api/containers', { token: await srv.tokenFor('alice') })).status, 200);
  });

  test('changing the password signs out other sessions', async () => {
    const other = await srv.tokenFor('alice');
    const current = await srv.tokenFor('alice');
    const newPassword = randomPassword();

    const res = await srv.request('POST', '/api/auth/change-password', {
      token: current, body: { currentPassword: srv.passwords.alice, newPassword }
    });
    assert.equal(res.status, 200);
    srv.passwords.alice = newPassword;

    assert.equal((await srv.request('GET', '/api/containers', { token: other })).status, 401);
    assert.equal((await srv.request('GET', '/api/containers', { token: current })).status, 401);
    assert.equal((await srv.request('GET', '/api/containers', { token: res.body.token })).status, 200);
  });

  test('admins can revoke all sessions of a user; others cannot', async () => {
    const aliceToken = await srv.tokenFor('alice');
    const alice = srv.readUsers().find(u => u.username === 'alice');

    const denied = await srv.request('POST', `/api/users/${alice.id}/revoke-sessions`, { token: aliceToken });
    assert.equal(denied.status, 403);

    const adminToken = await srv.tokenFor('admin');
    const ok = await srv.request('POST', `/api/users/${alice.id}/revoke-sessions`, { token: adminToken });
    assert.equal(ok.status, 200);
    assert.equal((await srv.request('GET', '/api/containers', { token: aliceToken })).status, 401);
  });

  test('an admin password reset or role change revokes the user\'s tokens', async () => {
    const adminToken = await srv.tokenFor('admin');
    const alice = srv.readUsers().find(u => u.username === 'alice');

    let aliceToken = await srv.tokenFor('alice');
    await srv.request('PUT', `/api/users/${alice.id}`, { token: adminToken, body: { role: 'admin' } });
    assert.equal((await srv.request('GET', '/api/containers', { token: aliceToken })).status, 401);
    await srv.request('PUT', `/api/users/${alice.id}`, { token: adminToken, body: { role: 'user', allowedContainers: ['web'] } });

    aliceToken = await srv.tokenFor('alice');
    const temp = randomPassword();
    await srv.request('PUT', `/api/users/${alice.id}`, { token: adminToken, body: { password: temp } });
    assert.equal((await srv.request('GET', '/api/containers', { token: aliceToken })).status, 401);

    // Put alice back to a normal state for later tests
    const login = await srv.login('alice', temp);
    const newPassword = randomPassword();
    await srv.request('POST', '/api/auth/change-password', {
      token: login.body.token, body: { currentPassword: temp, newPassword }
    });
    srv.passwords.alice = newPassword;
  });

  test('WebSocket: a revoked session is closed while streaming', async () => {
    const token = await srv.tokenFor('alice');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitFor(m => m.type === 'log');

      await srv.request('POST', '/api/auth/logout-all', { token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'failed', { timeout: 1000 });
      assert.equal(await client.waitForClose(), 4401);
      assert.equal(srv.docker.followerCount('web'), 0);
    } finally {
      client.close();
    }
  });

  test('WebSocket: re-authenticating with a refreshed token keeps the stream', async () => {
    const token = await srv.tokenFor('alice');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitFor(m => m.type === 'log');

      srv.clock.advance(14 * 60 * 1000);
      const refreshed = (await srv.request('POST', '/api/auth/refresh', { token })).body.token;
      const from = client.messages.length;
      client.send({ action: 'auth', token: refreshed });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success', { from });

      // The old token expires, the stream keeps running on the refreshed one
      srv.clock.advance(2 * 60 * 1000);
      await delay(150);
      srv.docker.emitLog('web', 'still streaming');
      await client.waitFor(m => m.type === 'log' && m.data.message === 'still streaming');
      assert.equal(client.isClosed, false);
    } finally {
      client.close();
    }
  });

  test('WebSocket: an expired session token ends the stream', async () => {
    const token = await srv.tokenFor('alice');
    const client = await connectWs(srv.wsUrl);
    try {
      client.send({ action: 'auth', token });
      await client.waitFor(m => m.type === 'auth' && m.status === 'success');
      client.send({ action: 'subscribe', containerId: 'web' });
      await client.waitFor(m => m.type === 'log');

      srv.clock.advance(16 * 60 * 1000);
      assert.equal(await client.waitForClose(1000), 4401);
    } finally {
      client.close();
    }
  });

  test('the revocation list is not world-readable', () => {
    const mode = fs.statSync(srv.revocationFile).mode & 0o777;
    assert.equal(mode & 0o077, 0);
  });
});
