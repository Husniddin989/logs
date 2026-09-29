const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./support/harness');

describe('HTTP hardening', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({
      users: [{ username: 'admin', role: 'admin' }],
      containers: []
    });
  });

  after(() => srv.close());

  test('the X-Powered-By header is not sent', async () => {
    const res = await srv.request('GET', '/api/health');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('malformed JSON gets a JSON 400, not an HTML page', async () => {
    const res = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.error, 'Invalid JSON body');
  });

  test('by default no cross-origin ACAO header is sent (same-origin only)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('CORS allow-list', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({
      users: [{ username: 'admin', role: 'admin' }],
      containers: [],
      appOptions: { corsOrigins: ['https://app.example'] }
    });
  });

  after(() => srv.close());

  test('an allowed origin is reflected', async () => {
    const res = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { Origin: 'https://app.example' }
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
  });

  test('a foreign origin is not reflected', async () => {
    const res = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
