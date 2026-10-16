import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

const ADMIN = { 'x-admin-token': 'entry_hardening_admin' };
const AUTH = { Authorization: 'Bearer user_entry_hardening' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const ROUTES = [
  ['/v1/chat/completions', CHAT],
  ['/v1/messages', { ...CHAT, max_tokens: 32 }],
  ['/v1/responses', { model: 'm', input: 'hi' }],
];
const FINISH = [
  { type: 'text-start' },
  { type: 'text-delta', text: 'hello' },
  { type: 'text-end' },
  { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 3 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 9, outputTokens: 3 } },
].map(event => JSON.stringify(event)).join('\n') + '\n';

function rawRequest(proxy, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1');
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('No complete HTTP response before timeout: ' + JSON.stringify(raw)));
    }, 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { raw += chunk; });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const statusLine = raw.match(/^HTTP\/1\.[01] (\d{3})\b/);
      if (!statusLine) reject(new Error('Missing HTTP status line: ' + JSON.stringify(raw)));
      else resolve({ status: Number(statusLine[1]), raw });
    });
  });
}

async function admin(proxy, method, path, body) {
  const response = await fetch(proxy.base + path, {
    method,
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, method === 'POST' ? 201 : 200, await response.clone().text());
  return response.json();
}

function usageReply(req, res) {
  let body;
  if (req.url.startsWith('/alpha/whoami')) body = { org: { id: 'entry_org' } };
  else if (req.url.startsWith('/alpha/billing/credits')) {
    body = { credits: { planId: 'individual-go', monthlyCredits: 100 } };
  } else if (req.url.startsWith('/alpha/billing/subscriptions')) {
    body = { data: {
      planId: 'individual-go', status: 'active',
      currentPeriodStart: new Date(Date.now() - 3600000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
    } };
  } else if (req.url.startsWith('/alpha/usage/summary')) body = { totalCost: 0 };
  else return false;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function withAccount(run) {
  const fixture = await setup({
    env: { CC_ADMIN_TOKEN: ADMIN['x-admin-token'], CC_USAGE_REFRESH_MS: '600000', CC_MAX_BODY_MB: '1' },
    onRequest: usageReply,
  });
  try {
    const account = (await admin(fixture.proxy, 'POST', '/admin/api/accounts', {
      name: 'entry-limited', apiKey: 'user_entry_pool', maxInflight: 1,
    })).account;
    const client = (await admin(fixture.proxy, 'POST', '/admin/api/clients', { name: 'entry-client' })).client;
    const headers = { Authorization: 'Bearer ' + client.token };
    const inFlight = async () => (await admin(fixture.proxy, 'GET', '/admin/api/metrics'))
      .accounts.find(item => item.id === account.id).components.inFlight;
    await run({ ...fixture, headers, inFlight });
  } finally { await fixture.close(); }
}

async function assertNormal(proxy, headers, path = '/v1/chat/completions', body = CHAT) {
  const response = await proxy.post(path, body, headers);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /hello/);
}

for (const [path, body] of ROUTES) {
  test('entry auth before body: ' + path, async () => {
    const fixture = await setup({ env: { CC_MAX_BODY_MB: '100' } });
    try {
      const response = await rawRequest(fixture.proxy,
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 52428800\r\nConnection: close\r\n\r\n{`);
      assert.equal(response.status, 401);
      assert.equal(fixture.mock.generateCount(), 0);
    } finally { await fixture.close(); }
  });

  test('entry oversized Content-Length before body: ' + path, async () => {
    const fixture = await setup({ env: { CC_MAX_BODY_MB: '1' } });
    try {
      const response = await rawRequest(fixture.proxy,
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${AUTH.Authorization}\r\nContent-Length: 2097152\r\nConnection: close\r\n\r\n{`);
      assert.equal(response.status, 413);
      assert.match(response.raw, /exceeds 1MB limit/);
      assert.equal(fixture.mock.generateCount(), 0);
    } finally { await fixture.close(); }
  });

  test('entry chunked body cumulative limit: ' + path, async () => {
    const fixture = await setup({ env: { CC_MAX_BODY_MB: '1' } });
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.request(fixture.proxy.base + path, {
          method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
        }, incoming => {
          let raw = '';
          incoming.setEncoding('utf8');
          incoming.on('data', chunk => { raw += chunk; });
          incoming.on('end', () => resolve({ status: incoming.statusCode, raw }));
          incoming.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('chunked request timed out')));
        for (let chunk = 0; chunk < 17; chunk++) request.write(Buffer.alloc(65536, 'x'));
        request.end();
      });
      assert.equal(response.status, 413);
      assert.match(response.raw, /body is .*MB\+/);
      assert.equal(fixture.mock.generateCount(), 0);
      await assertNormal(fixture.proxy, AUTH, path, body);
    } finally { await fixture.close(); }
  });

  test('entry valid pool token still succeeds: ' + path, async () => {
    await withAccount(async ({ proxy, headers, inFlight }) => {
      await assertNormal(proxy, headers, path, body);
      assert.equal(await inFlight(), 0);
    });
  });
}

test('entry release missing responses input before normal request', async () => {
  await withAccount(async ({ proxy, headers, inFlight }) => {
    const response = await proxy.post('/v1/responses', { model: 'm' }, headers);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /input is required/);
    assert.equal(await inFlight(), 0);
    await assertNormal(proxy, headers);
    assert.equal(await inFlight(), 0);
  });
});

test('entry release messages conversion exception before normal request', async () => {
  await withAccount(async ({ proxy, headers, inFlight }) => {
    const response = await proxy.post('/v1/messages', { model: 'm', messages: { bad: true } }, headers);
    assert.ok(response.status >= 400 && response.status <= 599);
    await response.text();
    assert.equal(await inFlight(), 0);
    await assertNormal(proxy, headers);
    assert.equal(await inFlight(), 0);
  });
});

test('entry release body validation and build exceptions on all routes', async () => {
  await withAccount(async ({ proxy, headers, inFlight }) => {
    for (const [path] of ROUTES) {
      for (const body of ['{bad json', 'null']) {
        const response = await proxy.post(path, body, headers);
        assert.ok(response.status >= 400 && response.status <= 599);
        await response.text();
        assert.equal(await inFlight(), 0, path + ' must release on invalid body');
      }
      const response = await rawRequest(proxy,
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${headers.Authorization}\r\nContent-Length: 2097152\r\nConnection: close\r\n\r\n{`);
      assert.equal(response.status, 413);
      assert.equal(await inFlight(), 0, path + ' must release on oversized declaration');
      await assertNormal(proxy, headers);
    }
    const response = await proxy.post('/v1/chat/completions', { model: 'm', messages: {} }, headers);
    assert.ok(response.status >= 400 && response.status <= 599);
    await response.text();
    assert.equal(await inFlight(), 0);
    await assertNormal(proxy, headers);
    assert.equal(await inFlight(), 0);
  });
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail('condition not reached before timeout');
}

async function checkGate(limit) {
  const held = [];
  const completed = [];
  const controller = new AbortController();
  const fixture = await setup({
    env: {
      CC_ADMIN_TOKEN: ADMIN['x-admin-token'],
      CC_MAX_INFLIGHT: limit === 32 ? undefined : '0',
    },
    onRequest(req, res) {
      if (req.url !== '/alpha/generate') return false;
      held.push(res);
      return true;
    },
  });
  const requests = [];
  const release = () => {
    for (const response of held) {
      if (response.writableEnded) continue;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(FINISH);
    }
  };
  try {
    for (let index = 0; index < 33; index++) {
      requests.push(fetch(fixture.proxy.base + '/v1/chat/completions', {
        method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(CHAT), signal: controller.signal,
      }).then(async response => {
        const result = { status: response.status, raw: await response.text() };
        completed.push(result);
        return result;
      }));
    }
    await waitFor(() => held.length + completed.length === 33);
    const metrics = await admin(fixture.proxy, 'GET', '/admin/api/metrics');
    if (limit === 32) {
      assert.ok(completed.some(response => response.status === 503 && /server_busy/.test(response.raw)),
        '33 concurrent requests must hit the default gate and receive 503 server_busy');
      assert.equal(held.length, 32);
      assert.equal(metrics.inflight, 32);
      const shell = await fixture.proxy.get('/admin');
      assert.equal(shell.status, 200);
      await shell.text();
      const health = await fixture.proxy.get('/health');
      assert.equal(health.status, 200);
      await health.text();
    } else {
      assert.equal(held.length, 33, 'explicit zero must admit more than 32 concurrent requests');
      assert.equal(metrics.inflight, 33);
      await waitFor(() => /CC_MAX_INFLIGHT=0.*memory exhaustion risk/.test(fixture.proxy.logs()));
    }
    assert.equal(metrics.maxInflight, limit);
    release();
    const results = await Promise.all(requests);
    assert.equal(results.filter(response => response.status === 200).length, limit === 32 ? 32 : 33);
    assert.equal((await admin(fixture.proxy, 'GET', '/admin/api/metrics')).inflight, 0);
  } finally {
    release();
    controller.abort();
    await Promise.allSettled(requests);
    await fixture.close();
  }
}

test('entry default gate limits 33 slow requests and exempts admin metrics', async () => {
  await checkGate(32);
});

test('entry explicit zero gate allows 33 slow requests and warns about memory', async () => {
  await checkGate(0);
});

test('entry malformed Host returns a 4xx status line without hanging', async () => {
  const fixture = await setup();
  try {
    for (const host of ['a b', '[', 'foo.com:99999']) {
      const response = await rawRequest(fixture.proxy,
        `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.ok(response.status >= 400 && response.status < 500, host + ': ' + response.raw);
    }
  } finally { await fixture.close(); }
});

test('entry normal Host preserves health routing', async () => {
  const fixture = await setup();
  try {
    for (const host of ['localhost', 'example.com:80', '[::1]:3000']) {
      const response = await rawRequest(fixture.proxy,
        `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.equal(response.status, 200);
    }
  } finally { await fixture.close(); }
});
