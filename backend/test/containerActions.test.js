const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./support/harness');
const { createContainerActions } = require('../src/containerActions');

const SELF_ID = `abcdef123456${'0'.repeat(52)}`;

describe('container actions API', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({
      users: [
        { username: 'admin', role: 'admin' },
        { username: 'admin2', role: 'admin' },
        { username: 'alice', role: 'user', allowedContainers: ['web'] }
      ],
      containers: [
        { name: 'web' },
        { name: 'worker' },
        { name: 'old-job', state: 'exited' },
        { name: 'busy-stopped', state: 'exited' },
        { name: 'postgres-main', state: 'running' },
        { name: 'viewer-frontend', labels: { 'docker-log-viewer.protected': 'true' } },
        { id: SELF_ID, name: 'viewer-backend' }
      ],
      appOptions: {
        containerActions: docker => createContainerActions({
          docker,
          enabled: true,
          protectedContainers: ['postgres-*'],
          selfIdPrefix: SELF_ID.slice(0, 12),
          maxPerMinute: 50
        })
      }
    });
  });

  after(() => srv.close());

  async function unlock(username = 'admin') {
    const token = await srv.tokenFor(username);
    const res = await srv.request('POST', '/api/auth/elevate', { token, body: { password: srv.passwords[username] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { token, actionToken: res.body.actionToken };
  }

  function act(ref, body, { token, actionToken }) {
    return srv.request('POST', `/api/containers/${encodeURIComponent(ref)}/actions`, {
      token, body, headers: actionToken ? { 'X-Action-Token': actionToken } : {}
    });
  }

  const idOf = name => srv.docker.containers.find(c => c.name === name).id;

  test('only admins reach the action routes', async () => {
    const alice = await srv.tokenFor('alice');
    for (const [method, url, body] of [
      ['GET', '/api/container-actions'],
      ['POST', '/api/auth/elevate', { password: srv.passwords.alice }],
      ['POST', '/api/containers/web/actions', { action: 'stop' }]
    ]) {
      assert.equal((await srv.request(method, url, { body })).status, 401, url);
      assert.equal((await srv.request(method, url, { token: alice, body })).status, 403, url);
    }
    assert.equal(srv.docker.actionCalls.length, 0);
  });

  test('an action needs the re-entered password, not just a session', async () => {
    const token = await srv.tokenFor('admin');
    const res = await act('web', { action: 'stop' }, { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'ACTION_TOKEN_REQUIRED');

    // A session token is not an action token
    const reused = await act('web', { action: 'stop' }, { token, actionToken: token });
    assert.equal(reused.status, 401);

    const wrong = await srv.request('POST', '/api/auth/elevate', { token, body: { password: 'not-the-password' } });
    assert.equal(wrong.status, 401);
    assert.equal(srv.docker.actionCalls.length, 0);
    assert.equal(srv.auditEvents('auth.elevate').at(-1).outcome, 'failure');
  });

  test('the action token is never accepted as a session token', async () => {
    const { actionToken } = await unlock();
    assert.equal((await srv.request('GET', '/api/containers', { token: actionToken })).status, 401);
    assert.equal((await srv.request('POST', '/api/auth/refresh', { token: actionToken })).status, 401);
  });

  test('stop, start and restart run on the full ID, whatever reference was sent', async () => {
    const session = await unlock();
    const prefix = idOf('worker').slice(0, 12);

    const stopped = await act(prefix, { action: 'stop' }, session);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.deepEqual(stopped.body.container, { id: idOf('worker'), name: 'worker' });
    assert.deepEqual(srv.docker.actionCalls.at(-1), { action: 'stop', ref: idOf('worker') });

    const again = await act('worker', { action: 'stop' }, session);
    assert.equal(again.body.changed, false, 'already stopped is not an error');

    assert.equal((await act('worker', { action: 'start' }, session)).status, 200);
    assert.equal((await act('worker', { action: 'restart' }, session)).status, 200);
    assert.equal(srv.docker.containers.find(c => c.name === 'worker').state, 'running');

    const audit = srv.auditEvents('container.action').filter(e => e.outcome === 'success');
    assert.ok(audit.some(e => e.action === 'stop' && e.container.name === 'worker' && e.actor.username === 'admin'));
  });

  test('protected containers cannot be touched', async () => {
    const session = await unlock();
    for (const name of ['viewer-frontend', 'viewer-backend', 'postgres-main']) {
      const res = await act(name, { action: 'stop' }, session);
      assert.equal(res.status, 403, name);
      assert.match(res.body.error, /himoyalangan/);
    }
    assert.equal(srv.docker.actionCalls.some(call => call.action === 'stop' && call.ref !== idOf('worker')), false);

    const admin = await srv.tokenFor('admin');
    const list = await srv.request('GET', '/api/containers', { token: admin });
    const byName = Object.fromEntries(list.body.map(c => [c.name, c.protected]));
    assert.equal(byName.web, null);
    assert.match(byName['viewer-frontend'], /label/);
    assert.match(byName['postgres-main'], /CONTAINER_ACTIONS_PROTECTED/);

    const alice = await srv.tokenFor('alice');
    const own = await srv.request('GET', '/api/containers', { token: alice });
    assert.equal('protected' in own.body[0], false, 'not shown to regular users');
  });

  test('remove needs a stopped container and its exact name, and keeps volumes', async () => {
    const session = await unlock();
    const running = await act('web', { action: 'remove', confirm: 'web' }, session);
    assert.equal(running.status, 409);

    const unconfirmed = await act('old-job', { action: 'remove', confirm: 'old' }, session);
    assert.equal(unconfirmed.status, 400);
    assert.ok(srv.docker.containers.some(c => c.name === 'old-job'));

    const removed = await act('old-job', { action: 'remove', confirm: 'old-job' }, session);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(srv.docker.containers.some(c => c.name === 'old-job'), false);
    assert.deepEqual(srv.docker.actionCalls.at(-1).opts, { v: false, force: false });
  });

  test('unknown actions and containers are rejected', async () => {
    const session = await unlock();
    assert.equal((await act('web', { action: 'kill' }, session)).status, 400);
    assert.equal((await act('web', {}, session)).status, 400);
    assert.equal((await act('nope', { action: 'stop' }, session)).status, 404);
    assert.equal((await act('../web', { action: 'stop' }, session)).status, 400);
  });

  test('an action token belongs to one admin and one sign-in', async () => {
    const first = await unlock('admin');

    const other = await srv.tokenFor('admin2');
    assert.equal((await act('busy-stopped', { action: 'start' }, { token: other, actionToken: first.actionToken })).status, 401);

    // A new sign-in (later auth_time) does not inherit the unlock
    srv.clock.advance(2000);
    const second = await srv.tokenFor('admin');
    assert.equal((await act('busy-stopped', { action: 'start' }, { token: second, actionToken: first.actionToken })).status, 401);

    // Signing out everywhere kills it too
    assert.equal((await srv.request('POST', '/api/auth/logout-all', { token: first.token })).status, 204);
    const fresh = await srv.tokenFor('admin');
    assert.equal((await act('busy-stopped', { action: 'start' }, { token: fresh, actionToken: first.actionToken })).status, 401);
    assert.equal(srv.docker.containers.find(c => c.name === 'busy-stopped').state, 'exited');
  });

  test('the action token expires after a few minutes', async () => {
    const session = await unlock();
    srv.clock.advance(6 * 60 * 1000);
    const res = await act('web', { action: 'restart' }, session);
    assert.equal(res.status, 401);
  });

  test('wrong passwords are throttled like logins', async () => {
    const token = await srv.tokenFor('admin2');
    for (let i = 0; i < 5; i++) {
      await srv.request('POST', '/api/auth/elevate', { token, body: { password: `wrong-${i}` } });
    }
    const locked = await srv.request('POST', '/api/auth/elevate', { token, body: { password: srv.passwords.admin2 } });
    assert.equal(locked.status, 429);
  });
});

describe('container actions switched off', () => {
  test('nothing can be unlocked or performed', async () => {
    const srv = await startTestServer({ users: [{ username: 'admin', role: 'admin' }], containers: [{ name: 'web' }] });
    try {
      const token = await srv.tokenFor('admin');
      const config = await srv.request('GET', '/api/container-actions', { token });
      assert.equal(config.body.enabled, false);
      const res = await srv.request('POST', '/api/auth/elevate', { token, body: { password: srv.passwords.admin } });
      assert.equal(res.status, 403);
      assert.equal(srv.docker.actionCalls.length, 0);
    } finally {
      await srv.close();
    }
  });
});

describe('container action rules', () => {
  test('one action per container at a time, and a per-admin rate limit', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const docker = {
      getContainer: id => ({
        inspect: async () => ({ Id: 'f'.repeat(64), Name: '/web', State: { Running: true }, Config: { Labels: {} } }),
        restart: async () => { await gate; }
      })
    };
    const actions = createContainerActions({ docker, enabled: true, selfIdPrefix: null, maxPerMinute: 2 });

    const first = actions.perform({ userId: 'u1', containerId: 'web', action: 'restart' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(actions.perform({ userId: 'u1', containerId: 'web', action: 'restart' }), { reason: 'busy' });
    release();
    await first;

    await actions.perform({ userId: 'u1', containerId: 'web', action: 'restart' });
    await assert.rejects(actions.perform({ userId: 'u1', containerId: 'web', action: 'restart' }), { reason: 'rate_limited' });
  });
});
