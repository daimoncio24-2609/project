const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
// Butuh PostgreSQL. Default: database `pwt_test` lokal; ganti lewat TEST_DATABASE_URL.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://pwt:pwt@127.0.0.1:5432/pwt_test';
const { pool } = require('../src/db');
const seed = require('../src/seed');
const app = require('../src/server');

let server, base;
test.before(async () => {
  await app.ready;
  await pool.query('TRUNCATE teams, users, sprints, workloads, metrics RESTART IDENTITY CASCADE');
  await seed();
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
test.after(async () => { server.close(); await pool.end(); });

async function call(method, url, body, cookie, headers = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers };
}
const login = async email => (await call('POST', '/api/login', { email, password: 'password123' })).cookie;

test('login & RBAC', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'budi@example.com', password: 'x' })).status, 401);
  const budi = await login('budi@example.com'), admin = await login('admin@example.com');
  assert.equal((await call('GET', '/api/users', null, budi)).body.length, 1);
  assert.equal((await call('POST', '/api/users', {}, budi)).status, 403);
  assert.ok((await call('GET', '/api/users', null, admin)).body.length >= 6);
  const sprints = (await call('GET', '/api/sprints', null, budi)).body;
  const sid = sprints.find(s => s.status === 'active').id;
  const andi = (await call('GET', '/api/users', null, admin)).body.find(u => u.email === 'andi@example.com');
  assert.equal((await call('GET', `/api/workloads?sprint=${sid}&user=${andi.id}`, null, budi)).status, 403);
  assert.equal((await call('GET', '/api/report?sprint=' + sid + '&format=csv', null, budi)).status, 403);
});

test('dashboard menghitung beban & metrik', async () => {
  const lead = await login('lead@example.com');
  const sid = (await call('GET', '/api/sprints', null, lead)).body.find(s => s.status === 'active').id;
  const d = (await call('GET', `/api/dashboard?sprint=${sid}`, null, lead)).body;
  const budi = d.rows.find(r => r.user.name === 'Budi Santoso');
  assert.equal(budi.workload.taken, 19);
  assert.equal(budi.workload.loadPct, 95);
  assert.equal(budi.workload.status, 'risk');
  assert.equal(budi.metrics.velocity, 8);
  assert.ok(d.totals.atRisk >= 1);
});

test('staff isi workload & metrik sendiri, metrik lead terkunci', async () => {
  const budi = await login('budi@example.com');
  const sid = (await call('GET', '/api/sprints', null, budi)).body.find(s => s.status === 'active').id;
  const w = await call('POST', '/api/workloads', { sprint_id: sid, title: 'Uji', size: 'M', category: 'feature' }, budi);
  assert.equal(w.body.points, 5);
  assert.equal((await call('PUT', `/api/workloads/${w.body.id}`, { status: 'done' }, budi)).body.status, 'done');
  assert.equal((await call('PUT', '/api/metrics', { sprint_id: sid, values: { unit_coverage: 91, code_quality: 99 } }, budi)).status, 400);
  assert.equal((await call('PUT', '/api/metrics', { sprint_id: sid, values: { unit_coverage: 150 } }, budi)).status, 400);
  assert.equal((await call('PUT', '/api/metrics', { sprint_id: sid, values: { unit_coverage: 91 } }, budi)).body.values.unit_coverage, 91);
});

test('webhook Jira & GitHub', async () => {
  const admin = await login('admin@example.com');
  const secret = (await call('GET', '/api/integrations', null, admin)).body.webhook_secret;
  assert.equal((await call('POST', '/api/webhooks/jira', {}, null)).status, 401);
  const issue = { issue: { key: 'DEV-777', fields: { summary: 'Payment', issuetype: { name: 'Bug' }, status: { name: 'Done', statusCategory: { key: 'done' } }, assignee: { emailAddress: 'andi@example.com' }, customfield_10016: 3 } } };
  assert.equal((await call('POST', `/api/webhooks/jira?secret=${secret}`, issue)).body.ok, true);
  assert.equal((await call('POST', `/api/webhooks/jira?secret=${secret}`, issue)).body.ok, true);
  const lead = await login('lead@example.com');
  const sid = (await call('GET', '/api/sprints', null, lead)).body.find(s => s.status === 'active').id;
  const before = (await call('GET', `/api/dashboard?sprint=${sid}`, null, lead)).body.rows.find(r => r.user.name === 'Andi Pratama').metrics.pr_count;
  const payload = JSON.stringify({ action: 'closed', pull_request: { merged: true, user: { login: 'andi-dev' } } });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const hdr = s => ({ 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': s });
  assert.equal((await (await fetch(base + '/api/webhooks/github', { method: 'POST', headers: hdr(sig), body: payload })).json()).counted, true);
  assert.equal((await fetch(base + '/api/webhooks/github', { method: 'POST', headers: hdr('sha256=00'), body: payload })).status, 401);
  const after = (await call('GET', `/api/dashboard?sprint=${sid}`, null, lead)).body.rows.find(r => r.user.name === 'Andi Pratama');
  assert.equal(after.metrics.pr_count, before + 1);
  assert.equal(after.workload.taken, 17); // 5+5+4 seed + 3 dari Jira (tidak ganda)
});

test('laporan xlsx/pdf/csv', async () => {
  const lead = await login('lead@example.com');
  const sid = (await call('GET', '/api/sprints', null, lead)).body[0].id;
  assert.equal((await call('GET', `/api/report?sprint=${sid}&format=xlsx`, null, lead)).body.subarray(0, 2).toString(), 'PK');
  assert.equal((await call('GET', `/api/report?sprint=${sid}&format=pdf`, null, lead)).body.subarray(0, 4).toString(), '%PDF');
  assert.ok((await call('GET', `/api/report?month=2026-08&format=csv`, null, lead)).body.toString().includes('Siska Dewi'));
});
