import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

const ADMIN = { 'x-admin-token': 'usage_cache_test' };

function usageJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('慢上游下额度接口快速返回 pending，后台完成后返回缓存行', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccp-usage-cache-'));
  writeFileSync(join(cwd, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 'acc_slow', name: 'slow', apiKey: 'slow_key' }],
    clients: [],
  }));
  const upstream = await setup({
    cwd,
    env: { CC_ADMIN_TOKEN: ADMIN['x-admin-token'], CC_USAGE_REFRESH_MS: '60000' },
    async onRequest(req, res) {
      if (req.url.startsWith('/alpha/')) await sleep(800);
      if (req.url.startsWith('/alpha/whoami')) return usageJson(res, { org: { id: 'org_slow' }, user: { userName: 'slow' } });
      if (req.url.startsWith('/alpha/billing/credits')) return usageJson(res, { credits: { planId: 'individual-go', monthlyCredits: 10 } });
      if (req.url.startsWith('/alpha/billing/subscriptions')) return usageJson(res, { data: { planId: 'individual-go', status: 'active' } });
      if (req.url.startsWith('/alpha/usage/summary')) return usageJson(res, { totalCost: 0 });
    },
  });
  try {
    const started = Date.now();
    const first = await upstream.proxy.get('/admin/api/usage', { headers: ADMIN });
    const elapsed = Date.now() - started;
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.ok(elapsed < 1000, 'cold usage response should be immediate: ' + elapsed + 'ms');
    assert.equal(firstBody.refreshing, true);
    assert.equal(firstBody.usage[0].pending, true);

    await sleep(2200);
    const second = await upstream.proxy.get('/admin/api/usage', { headers: ADMIN });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.refreshing, false);
    assert.equal(secondBody.usage[0].ok, true);
    assert.equal(secondBody.usage[0].id, 'acc_slow');
  } finally {
    await upstream.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
