const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const { q, one, tx, init } = require('./db');
const M = require('./metrics');
const S = require('./summary');
const R = require('./reports');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// ---------- util ----------
const getSetting = async k => (await one('SELECT value FROM settings WHERE key=$1', [k]))?.value;
const setSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v]);
const ensureSetting = (k, bytes) => q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [k, crypto.randomBytes(bytes).toString('hex')]);
const isDup = e => e && e.code === '23505';

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, position: u.position, team_id: u.team_id, capacity: u.capacity, github_username: u.github_username, active: !!u.active });

async function auth(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies.token || '', await getSetting('jwt_secret'));
    const u = await one('SELECT * FROM users WHERE id=$1 AND active', [uid]);
    if (!u) throw new Error('no user');
    req.user = u;
  } catch { return bad(res, 'Belum login', 401); }
  next();
}
const need = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : bad(res, 'Akses ditolak', 403);

// admin: semua; lead: satu tim; staff: diri sendiri
function canManage(viewer, target) {
  if (!target) return false;
  if (viewer.role === 'admin') return true;
  if (viewer.role === 'lead') return target.team_id != null && target.team_id === viewer.team_id;
  return viewer.id === target.id;
}
const userById = id => one('SELECT * FROM users WHERE id=$1', [Number(id) || 0]);

// ---------- auth ----------
const attempts = new Map();
app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const key = `${req.ip}|${String(email).toLowerCase()}`;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return bad(res, 'Terlalu banyak percobaan, coba lagi nanti', 429);
  const u = await one('SELECT * FROM users WHERE lower(email)=lower($1) AND active', [String(email || '')]);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) { a.n++; attempts.set(key, a); return bad(res, 'Email atau kata sandi salah', 401); }
  attempts.delete(key);
  const token = jwt.sign({ uid: u.id }, await getSetting('jwt_secret'), { expiresIn: '12h' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600e3 });
  res.json(publicUser(u));
}));
app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return bad(res, 'Kata sandi saat ini salah');
  if (String(next || '').length < 8) return bad(res, 'Kata sandi baru minimal 8 karakter');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(next, 10), req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/meta', auth, (_req, res) => res.json({
  positions: M.POSITIONS, categories: M.CATEGORIES, sizePoints: M.SIZE_POINTS, inputMetrics: M.INPUT_METRICS,
  labels: M.DERIVED_LABELS, headline: M.HEADLINE,
}));

// ---------- teams / users / sprints ----------
app.get('/api/teams', auth, wrap(async (req, res) => {
  const rows = await q('SELECT * FROM teams ORDER BY name');
  res.json(req.user.role === 'admin' ? rows : rows.filter(t => t.id === req.user.team_id));
}));
app.post('/api/teams', auth, need('admin'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'Nama tim wajib diisi');
  try { res.json(await one('INSERT INTO teams(name) VALUES($1) RETURNING *', [name])); }
  catch (e) { if (isDup(e)) return bad(res, 'Nama tim sudah ada'); throw e; }
}));
app.delete('/api/teams/:id', auth, need('admin'), wrap(async (req, res) => { await q('DELETE FROM teams WHERE id=$1', [Number(req.params.id) || 0]); res.json({ ok: true }); }));

app.get('/api/users', auth, wrap(async (req, res) => {
  let rows;
  if (req.user.role === 'admin') rows = await q('SELECT * FROM users ORDER BY name');
  else if (req.user.role === 'lead') rows = await q('SELECT * FROM users WHERE team_id=$1 ORDER BY name', [req.user.team_id]);
  else rows = [req.user];
  res.json(rows.map(publicUser));
}));

function validateUser(b, partial) {
  if (!partial || b.role !== undefined) if (!['admin', 'lead', 'staff'].includes(b.role)) return 'Peran tidak valid';
  if (b.role === 'staff' && !['BA', 'DEV', 'QA'].includes(b.position)) return 'Staff wajib punya posisi BA/DEV/QA';
  if (b.position && !['BA', 'DEV', 'QA'].includes(b.position)) return 'Posisi tidak valid';
  if (b.capacity !== undefined && !(Number(b.capacity) > 0)) return 'Kapasitas harus > 0';
  return null;
}
app.post('/api/users', auth, need('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email) return bad(res, 'Nama dan email wajib diisi');
  if (String(b.password || '').length < 8) return bad(res, 'Kata sandi minimal 8 karakter');
  const err = validateUser(b); if (err) return bad(res, err);
  try {
    const u = await one('INSERT INTO users(name,email,password_hash,role,position,team_id,capacity,github_username) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [b.name, b.email.toLowerCase(), bcrypt.hashSync(b.password, 10), b.role, b.position || null, b.team_id || null, Number(b.capacity) || 20, b.github_username || null]);
    res.json(publicUser(u));
  } catch (e) { if (isDup(e)) return bad(res, 'Email sudah terdaftar'); throw e; }
}));
app.put('/api/users/:id', auth, need('admin'), wrap(async (req, res) => {
  const u = await userById(req.params.id); if (!u) return bad(res, 'Tidak ditemukan', 404);
  const b = { ...u, ...req.body };
  const err = validateUser(b, true); if (err) return bad(res, err);
  if (u.id === req.user.id && (b.role !== 'admin' || req.body.active === false)) return bad(res, 'Tidak bisa menurunkan/menonaktifkan akun sendiri');
  if (req.body.password && String(req.body.password).length < 8) return bad(res, 'Kata sandi minimal 8 karakter');
  try {
    const nu = await one('UPDATE users SET name=$1,email=$2,role=$3,position=$4,team_id=$5,capacity=$6,github_username=$7,active=$8 WHERE id=$9 RETURNING *',
      [b.name, String(b.email).toLowerCase(), b.role, b.position || null, b.team_id || null, Number(b.capacity) || 20, b.github_username || null, !(b.active === false || b.active === 0), u.id]);
    if (req.body.password) await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(req.body.password, 10), u.id]);
    res.json(publicUser(nu));
  } catch (e) { if (isDup(e)) return bad(res, 'Email sudah terdaftar'); throw e; }
}));

app.get('/api/sprints', auth, wrap(async (_req, res) => res.json(await q('SELECT * FROM sprints ORDER BY start_date DESC, id DESC'))));
app.post('/api/sprints', auth, need('admin', 'lead'), wrap(async (req, res) => {
  const { name, start_date, end_date, status } = req.body || {};
  if (!name || !start_date || !end_date) return bad(res, 'Nama, tanggal mulai & selesai wajib');
  if (end_date < start_date) return bad(res, 'Tanggal selesai harus setelah mulai');
  if (status && !['planned', 'active', 'closed'].includes(status)) return bad(res, 'Status tidak valid');
  res.json(await one('INSERT INTO sprints(name,start_date,end_date,status) VALUES($1,$2,$3,$4) RETURNING *', [name, start_date, end_date, status || 'planned']));
}));
app.put('/api/sprints/:id', auth, need('admin', 'lead'), wrap(async (req, res) => {
  const s = await one('SELECT * FROM sprints WHERE id=$1', [Number(req.params.id) || 0]); if (!s) return bad(res, 'Tidak ditemukan', 404);
  const b = { ...s, ...req.body };
  if (!['planned', 'active', 'closed'].includes(b.status)) return bad(res, 'Status tidak valid');
  res.json(await one('UPDATE sprints SET name=$1,start_date=$2,end_date=$3,status=$4 WHERE id=$5 RETURNING *', [b.name, b.start_date, b.end_date, b.status, s.id]));
}));

// ---------- workloads ----------
app.get('/api/workloads', auth, wrap(async (req, res) => {
  const sprint = Number(req.query.sprint); if (!sprint) return bad(res, 'sprint wajib');
  const uid = Number(req.query.user) || req.user.id;
  const target = await userById(uid); if (!canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  res.json(await q('SELECT * FROM workloads WHERE user_id=$1 AND sprint_id=$2 ORDER BY id DESC', [uid, sprint]));
}));
function cleanWorkload(b) {
  if (!b.title || !String(b.title).trim()) return { error: 'Judul wajib diisi' };
  if (!M.CATEGORIES[b.category || 'feature']) return { error: 'Kategori tidak valid' };
  if (b.size && !M.SIZE_POINTS[b.size]) return { error: 'Ukuran harus S/M/L' };
  let points = b.points === '' || b.points == null ? (b.size ? M.SIZE_POINTS[b.size] : 0) : Number(b.points);
  const hours = Number(b.hours || 0);
  if (!(points >= 0) || !(hours >= 0)) return { error: 'Poin/jam tidak valid' };
  if (!['todo', 'in_progress', 'review', 'done', 'cancelled'].includes(b.status || 'todo')) return { error: 'Status tidak valid' };
  return { v: { ticket: b.ticket || null, title: String(b.title).trim(), category: b.category || 'feature', size: b.size || null, points, hours, status: b.status || 'todo' } };
}
app.post('/api/workloads', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const uid = Number(b.user_id) || req.user.id;
  const target = await userById(uid); if (!canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  if (!(await one('SELECT 1 AS x FROM sprints WHERE id=$1', [Number(b.sprint_id) || 0]))) return bad(res, 'Sprint tidak ditemukan');
  const { v, error } = cleanWorkload(b); if (error) return bad(res, error);
  try {
    res.json(await one('INSERT INTO workloads(user_id,sprint_id,ticket,title,category,size,points,hours,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [uid, b.sprint_id, v.ticket, v.title, v.category, v.size, v.points, v.hours, v.status]));
  } catch (e) { if (isDup(e)) return bad(res, 'Nomor tiket sudah dipakai di sprint ini'); throw e; }
}));
app.put('/api/workloads/:id', auth, wrap(async (req, res) => {
  const w = await one('SELECT * FROM workloads WHERE id=$1', [Number(req.params.id) || 0]); if (!w) return bad(res, 'Tidak ditemukan', 404);
  if (!canManage(req.user, await userById(w.user_id))) return bad(res, 'Akses ditolak', 403);
  const { v, error } = cleanWorkload({ ...w, ...req.body, points: req.body.points ?? w.points }); if (error) return bad(res, error);
  res.json(await one('UPDATE workloads SET ticket=$1,title=$2,category=$3,size=$4,points=$5,hours=$6,status=$7 WHERE id=$8 RETURNING *', [v.ticket, v.title, v.category, v.size, v.points, v.hours, v.status, w.id]));
}));
app.delete('/api/workloads/:id', auth, wrap(async (req, res) => {
  const w = await one('SELECT * FROM workloads WHERE id=$1', [Number(req.params.id) || 0]); if (!w) return bad(res, 'Tidak ditemukan', 404);
  if (!canManage(req.user, await userById(w.user_id))) return bad(res, 'Akses ditolak', 403);
  await q('DELETE FROM workloads WHERE id=$1', [w.id]);
  res.json({ ok: true });
}));

// ---------- metrics (input manual) ----------
app.get('/api/metrics', auth, wrap(async (req, res) => {
  const sprint = Number(req.query.sprint); const uid = Number(req.query.user) || req.user.id;
  const target = await userById(uid); if (!canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  res.json({ values: await S.metricsMap(uid, sprint), summary: await S.memberSummary(target, sprint) });
}));
app.put('/api/metrics', auth, wrap(async (req, res) => {
  const { user_id, sprint_id, values } = req.body || {};
  const uid = Number(user_id) || req.user.id;
  const target = await userById(uid); if (!canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  if (!target.position) return bad(res, 'Pengguna tidak punya posisi');
  if (!(await one('SELECT 1 AS x FROM sprints WHERE id=$1', [Number(sprint_id) || 0]))) return bad(res, 'Sprint tidak ditemukan');
  const defs = Object.fromEntries(M.INPUT_METRICS[target.position].map(d => [d.key, d]));
  const isLead = req.user.role !== 'staff';
  const errors = [];
  await tx(async c => {
    for (const [k, raw] of Object.entries(values || {})) {
      const d = defs[k]; if (!d) continue;
      if (d.entry === 'lead' && !isLead) { errors.push(`${d.label}: hanya diisi Team Lead/Admin`); continue; }
      if (raw === '' || raw == null) { await q('DELETE FROM metrics WHERE user_id=$1 AND sprint_id=$2 AND key=$3', [uid, sprint_id, k], c); continue; }
      const n = Number(raw);
      if (!isFinite(n) || n < 0 || (d.max != null && n > d.max)) { errors.push(`${d.label}: nilai tidak valid`); continue; }
      await q(`INSERT INTO metrics(user_id,sprint_id,key,value,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id,sprint_id,key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`, [uid, sprint_id, k, n, req.user.id], c);
    }
  });
  if (errors.length) return bad(res, errors.join('; '));
  res.json({ values: await S.metricsMap(uid, sprint_id), summary: await S.memberSummary(target, sprint_id) });
}));

// ---------- dashboard & laporan ----------
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const sprint = Number(req.query.sprint); if (!sprint) return bad(res, 'sprint wajib');
  const team = req.user.role === 'admin' ? Number(req.query.team) || null : req.user.team_id;
  const [sum, trend] = await Promise.all([S.sprintSummary(req.user, sprint, team), S.trend(req.user, team)]);
  res.json({ ...sum, trend });
}));

app.get('/api/report', auth, need('admin', 'lead'), wrap(async (req, res) => {
  const params = { sprint: Number(req.query.sprint) || null, month: req.query.month || null, team: req.user.role === 'admin' ? req.query.team : req.user.team_id };
  if (!params.sprint && !/^\d{4}-\d{2}$/.test(params.month || '')) return bad(res, 'Pilih sprint atau bulan (YYYY-MM)');
  const data = await R.buildRows(req.user, params);
  if (!data.sprints.length) return bad(res, 'Tidak ada sprint pada periode tersebut', 404);
  const base = `laporan-${params.sprint ? 'sprint-' + params.sprint : params.month}`;
  const fmt = req.query.format;
  if (fmt === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(Buffer.from(await R.toXlsx(data, req.user)));
  }
  if (fmt === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
    return R.toPdf(data, res);
  }
  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(R.toCsv(data));
  }
  res.json({ sprints: data.sprints, rows: data.rows.map(({ raw, ...r }) => r) });
}));

// ---------- integrasi: webhook Jira & GitHub ----------
app.get('/api/integrations', auth, need('admin'), wrap(async (_req, res) => res.json({ webhook_secret: await getSetting('webhook_secret') })));
app.post('/api/integrations/rotate', auth, need('admin'), wrap(async (_req, res) => {
  const s = crypto.randomBytes(16).toString('hex'); await setSetting('webhook_secret', s); res.json({ webhook_secret: s });
}));

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const activeSprint = () => one("SELECT * FROM sprints WHERE status='active' ORDER BY start_date DESC, id DESC LIMIT 1");
const bump = (uid, sprintId, key) => q(`INSERT INTO metrics(user_id,sprint_id,key,value) VALUES($1,$2,$3,1)
  ON CONFLICT(user_id,sprint_id,key) DO UPDATE SET value=metrics.value+1, updated_at=now()`, [uid, sprintId, key]);

app.post('/api/webhooks/jira', wrap(async (req, res) => {
  const given = req.get('x-webhook-secret') || req.query.secret || '';
  if (!safeEq(given, await getSetting('webhook_secret'))) return bad(res, 'Secret tidak valid', 401);
  const issue = req.body?.issue; if (!issue?.key) return bad(res, 'Payload Jira tidak dikenali');
  const f = issue.fields || {};
  const email = f.assignee?.emailAddress; if (!email) return res.json({ ignored: 'tanpa assignee' });
  const u = await one('SELECT * FROM users WHERE lower(email)=lower($1) AND active', [email]);
  if (!u) return res.json({ ignored: 'assignee tidak terdaftar' });
  const sprint = await activeSprint(); if (!sprint) return res.json({ ignored: 'tidak ada sprint aktif' });
  const type = String(f.issuetype?.name || '').toLowerCase();
  const category = type.includes('bug') ? 'bug' : type.includes('debt') ? 'techdebt' : type.includes('test') ? 'test' : 'feature';
  const cat = f.status?.statusCategory?.key; const sname = String(f.status?.name || '').toLowerCase();
  const status = cat === 'done' ? 'done' : sname.includes('review') ? 'review' : cat === 'indeterminate' ? 'in_progress' : 'todo';
  const points = Number(f.customfield_10016 ?? f.storyPoints ?? 0) || 0;
  await q(`INSERT INTO workloads(user_id,sprint_id,ticket,title,category,points,status,source) VALUES($1,$2,$3,$4,$5,$6,$7,'jira')
    ON CONFLICT(source,ticket,sprint_id) WHERE ticket IS NOT NULL DO UPDATE SET user_id=excluded.user_id,title=excluded.title,category=excluded.category,points=excluded.points,status=excluded.status`,
    [u.id, sprint.id, issue.key, f.summary || issue.key, category, points, status]);
  res.json({ ok: true, ticket: issue.key, status });
}));

app.post('/api/webhooks/github', wrap(async (req, res) => {
  const secret = await getSetting('webhook_secret');
  const sig = req.get('x-hub-signature-256');
  if (sig) {
    const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    if (!safeEq(sig, exp)) return bad(res, 'Signature tidak valid', 401);
  } else if (!safeEq(req.get('x-webhook-secret') || req.query.secret || '', secret)) return bad(res, 'Secret tidak valid', 401);
  const ev = req.get('x-github-event'); const b = req.body || {};
  const sprint = await activeSprint(); if (!sprint) return res.json({ ignored: 'tidak ada sprint aktif' });
  const find = login => login ? one('SELECT * FROM users WHERE lower(github_username)=lower($1) AND active', [login]) : null;
  if (ev === 'pull_request' && b.action === 'closed' && b.pull_request?.merged) {
    const u = await find(b.pull_request.user?.login); if (u) await bump(u.id, sprint.id, 'pr_count');
    return res.json({ ok: true, counted: !!u });
  }
  if (ev === 'pull_request_review' && b.action === 'submitted') {
    const u = await find(b.review?.user?.login); if (u && b.review.user.login !== b.pull_request?.user?.login) await bump(u.id, sprint.id, 'reviews_count');
    return res.json({ ok: true, counted: !!u });
  }
  res.json({ ignored: ev || 'event tidak didukung' });
}));

// ---------- static & error ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (_req, res) => bad(res, 'Endpoint tidak ditemukan', 404));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Terjadi kesalahan server' }); });

// Menyiapkan skema & secret sebelum menerima request. Dipanggil oleh start() dan test.
const ready = (async () => {
  await init();
  await ensureSetting('jwt_secret', 32);
  await ensureSetting('webhook_secret', 16);
})();
app.ready = ready;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  ready.then(() => app.listen(port, () => console.log(`Aplikasi berjalan di http://localhost:${port}`)))
    .catch(e => { console.error('Gagal menyambung ke PostgreSQL:', e.message); process.exit(1); });
}
module.exports = app;
