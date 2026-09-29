const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, connectWs } = require('./support/harness');
const { frame } = require('./support/fakeDocker');
const { demuxDockerStream, parseDockerLogs } = require('../src/dockerLogs');

// Core log-viewing behaviour that every security change must keep working.

let srv;

before(async () => {
  srv = await startTestServer({
    users: [{ username: 'admin', role: 'admin', allowedContainers: ['*'] }],
    containers: [
      {
        name: 'web',
        logs: [
          ...Array.from({ length: 25 }, (_, i) => `line ${i + 1}`),
          { text: 'boom', stream: 'stderr' }
        ]
      }
    ]
  });
});

after(() => srv.close());

test('health check needs no auth', async () => {
  const res = await srv.request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('admin can list containers', async () => {
  const token = await srv.tokenFor('admin');
  const res = await srv.request('GET', '/api/containers', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map(c => c.name), ['web']);
});

test('logs endpoint paginates newest first and keeps stderr', async () => {
  const token = await srv.tokenFor('admin');
  const id = srv.docker.containers[0].id;

  const page1 = await srv.request('GET', `/api/containers/${id}/logs?timeRange=1h&page=1&limit=10`, { token });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.pagination.totalLogs, 26);
  assert.equal(page1.body.pagination.hasMore, true);
  assert.equal(page1.body.logs.at(-1).message, 'boom');
  assert.equal(page1.body.logs.at(-1).stream, 'stderr');

  const page3 = await srv.request('GET', `/api/containers/${id}/logs?timeRange=1h&page=3&limit=10`, { token });
  assert.equal(page3.body.logs[0].message, 'line 1');
  assert.equal(page3.body.pagination.hasMore, false);
});

test('logs endpoint filters by search term', async () => {
  const token = await srv.tokenFor('admin');
  const id = srv.docker.containers[0].id;
  const res = await srv.request('GET', `/api/containers/${id}/logs?tail=500&search=LINE%202`, { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.logs.map(l => l.message), ['line 2', 'line 20', 'line 21', 'line 22', 'line 23', 'line 24', 'line 25']);
});

test('WebSocket streams existing and new log lines', async () => {
  const token = await srv.tokenFor('admin');
  const client = await connectWs(srv.wsUrl);
  try {
    client.send({ action: 'auth', token });
    await client.waitFor(m => m.type === 'auth' && m.status === 'success');

    client.send({ action: 'subscribe', containerId: srv.docker.containers[0].id, filter: '' });
    await client.waitFor(m => m.type === 'log' && m.data.message === 'boom');

    srv.docker.emitLog('web', 'fresh line');
    await client.waitFor(m => m.type === 'log' && m.data.message === 'fresh line');
  } finally {
    client.close();
  }
});

test('demuxer carries incomplete frames over to the next chunk', () => {
  const whole = Buffer.concat([frame('stdout', 'first\n'), frame('stderr', 'second\n')]);
  const cut = whole.length - 3;

  const firstPass = demuxDockerStream(whole.subarray(0, cut));
  assert.equal(firstPass.frames.length, 1);
  assert.equal(firstPass.frames[0].text, 'first\n');

  const secondPass = demuxDockerStream(Buffer.concat([firstPass.rest, whole.subarray(cut)]));
  assert.deepEqual(secondPass.frames, [{ stream: 'stderr', text: 'second\n' }]);
});

test('parser handles raw TTY output without frame headers', () => {
  const lines = parseDockerLogs(Buffer.from('2024-01-01T00:00:00.000000000Z hello tty\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'hello tty');
  assert.equal(lines[0].stream, 'stdout');
});
