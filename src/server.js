const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const M = require('./metrics');
const S = require('./summary');
const R = require('./reports');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// ---------- util ----------
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
if (!getSetting('jwt_secret')) setSetting('jwt_secret', crypto.randomBytes(32).toString('hex'));
if (!getSetting('webhook_secret')) setSetting('webhook_secret', crypto.randomBytes(16).toString('hex'));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, position: u.position, team_id: u.team_id, capacity: u.capacity, github_username: u.github_username, active: !!u.active });

function auth(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies.token || '', getSetting('jwt_secret'));
    const u = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(uid);
    if (!u) throw new Error('no user');
    req.user = u;
    next();
  } catch { bad(res, 'Belum login', 401); }
}
const need = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : bad(res, 'Akses ditolak', 403);

// admin: semua; lead: satu tim; staff: diri sendiri
function canManage(viewer, target) {
  if (viewer.role === 'admin') return true;
  if (viewer.role === 'lead') return target.team_id != null && target.team_id === viewer.team_id;
  return viewer.id === target.id;
}
const userById = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);

// ---------- auth ----------
const attempts = new Map();
app.post('/api/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const key = `${req.ip}|${String(email).toLowerCase()}`;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return bad(res, 'Terlalu banyak percobaan, coba lagi nanti', 429);
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1').get(String(email || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) { a.n++; attempts.set(key, a); return bad(res, 'Email atau kata sandi salah', 401); }
  attempts.delete(key);
  const token = jwt.sign({ uid: u.id }, getSetting('jwt_secret'), { expiresIn: '12h' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600e3 });
  res.json(publicUser(u));
}));
app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));
app.post('/api/me/password', auth, wrap((req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return bad(res, 'Kata sandi saat ini salah');
  if (String(next || '').length < 8) return bad(res, 'Kata sandi baru minimal 8 karakter');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), req.user.id);
  res.json({ ok: true });
}));

app.get('/api/meta', auth, (_req, res) => res.json({
  positions: M.POSITIONS, categories: M.CATEGORIES, sizePoints: M.SIZE_POINTS, inputMetrics: M.INPUT_METRICS,
  labels: M.DERIVED_LABELS, headline: M.HEADLINE,
}));

// ---------- teams / users / sprints ----------
app.get('/api/teams', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM teams ORDER BY name').all();
  res.json(req.user.role === 'admin' ? rows : rows.filter(t => t.id === req.user.team_id));
});
app.post('/api/teams', auth, need('admin'), wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'Nama tim wajib diisi');
  try { res.json({ id: db.prepare('INSERT INTO teams(name) VALUES(?)').run(name).lastInsertRowid, name }); }
  catch { bad(res, 'Nama tim sudah ada'); }
}));
app.delete('/api/teams/:id', auth, need('admin'), (req, res) => { db.prepare('DELETE FROM teams WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/users', auth, (req, res) => {
  let rows;
  if (req.user.role === 'admin') rows = db.prepare('SELECT * FROM users ORDER BY name').all();
  else if (req.user.role === 'lead') rows = db.prepare('SELECT * FROM users WHERE team_id=? ORDER BY name').all(req.user.team_id);
  else rows = [req.user];
  res.json(rows.map(publicUser));
});

function validateUser(b, partial) {
  if (!partial || b.role !== undefined) if (!['admin', 'lead', 'staff'].includes(b.role)) return 'Peran tidak valid';
  if (b.role === 'staff' && !['BA', 'DEV', 'QA'].includes(b.position)) return 'Staff wajib punya posisi BA/DEV/QA';
  if (b.position && !['BA', 'DEV', 'QA'].includes(b.position)) return 'Posisi tidak valid';
  if (b.capacity !== undefined && !(Number(b.capacity) > 0)) return 'Kapasitas harus > 0';
  return null;
}
app.post('/api/users', auth, need('admin'), wrap((req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email) return bad(res, 'Nama dan email wajib diisi');
  if (String(b.password || '').length < 8) return bad(res, 'Kata sandi minimal 8 karakter');
  const err = validateUser(b); if (err) return bad(res, err);
  try {
    const id = db.prepare('INSERT INTO users(name,email,password_hash,role,position,team_id,capacity,github_username) VALUES(?,?,?,?,?,?,?,?)')
      .run(b.name, b.email.toLowerCase(), bcrypt.hashSync(b.password, 10), b.role, b.position || null, b.team_id || null, Number(b.capacity) || 20, b.github_username || null).lastInsertRowid;
    res.json(publicUser(userById(id)));
  } catch { bad(res, 'Email sudah terdaftar'); }
}));
app.put('/api/users/:id', auth, need('admin'), wrap((req, res) => {
  const u = userById(req.params.id); if (!u) return bad(res, 'Tidak ditemukan', 404);
  const b = { ...u, ...req.body };
  const err = validateUser(b, true); if (err) return bad(res, err);
  if (u.id === req.user.id && (b.role !== 'admin' || req.body.active === false)) return bad(res, 'Tidak bisa menurunkan/menonaktifkan akun sendiri');
  try {
    db.prepare('UPDATE users SET name=?,email=?,role=?,position=?,team_id=?,capacity=?,github_username=?,active=? WHERE id=?')
      .run(b.name, String(b.email).toLowerCase(), b.role, b.position || null, b.team_id || null, Number(b.capacity) || 20, b.github_username || null, b.active === false || b.active === 0 ? 0 : 1, u.id);
    if (req.body.password) {
      if (String(req.body.password).length < 8) return bad(res, 'Kata sandi minimal 8 karakter');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), u.id);
    }
    res.json(publicUser(userById(u.id)));
  } catch { bad(res, 'Email sudah terdaftar'); }
}));

app.get('/api/sprints', auth, (_req, res) => res.json(db.prepare('SELECT * FROM sprints ORDER BY start_date DESC').all()));
app.post('/api/sprints', auth, need('admin', 'lead'), wrap((req, res) => {
  const { name, start_date, end_date, status } = req.body || {};
  if (!name || !start_date || !end_date) return bad(res, 'Nama, tanggal mulai & selesai wajib');
  if (end_date < start_date) return bad(res, 'Tanggal selesai harus setelah mulai');
  const id = db.prepare('INSERT INTO sprints(name,start_date,end_date,status) VALUES(?,?,?,?)').run(name, start_date, end_date, status || 'planned').lastInsertRowid;
  res.json(db.prepare('SELECT * FROM sprints WHERE id=?').get(id));
}));
app.put('/api/sprints/:id', auth, need('admin', 'lead'), wrap((req, res) => {
  const s = db.prepare('SELECT * FROM sprints WHERE id=?').get(req.params.id); if (!s) return bad(res, 'Tidak ditemukan', 404);
  const b = { ...s, ...req.body };
  if (!['planned', 'active', 'closed'].includes(b.status)) return bad(res, 'Status tidak valid');
  db.prepare('UPDATE sprints SET name=?,start_date=?,end_date=?,status=? WHERE id=?').run(b.name, b.start_date, b.end_date, b.status, s.id);
  res.json(db.prepare('SELECT * FROM sprints WHERE id=?').get(s.id));
}));

// ---------- workloads ----------
app.get('/api/workloads', auth, wrap((req, res) => {
  const sprint = Number(req.query.sprint); if (!sprint) return bad(res, 'sprint wajib');
  const uid = Number(req.query.user) || req.user.id;
  const target = userById(uid); if (!target || !canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  res.json(db.prepare('SELECT * FROM workloads WHERE user_id=? AND sprint_id=? ORDER BY id DESC').all(uid, sprint));
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
app.post('/api/workloads', auth, wrap((req, res) => {
  const b = req.body || {};
  const uid = Number(b.user_id) || req.user.id;
  const target = userById(uid); if (!target || !canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  if (!db.prepare('SELECT 1 FROM sprints WHERE id=?').get(b.sprint_id)) return bad(res, 'Sprint tidak ditemukan');
  const { v, error } = cleanWorkload(b); if (error) return bad(res, error);
  try {
    const id = db.prepare('INSERT INTO workloads(user_id,sprint_id,ticket,title,category,size,points,hours,status) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(uid, b.sprint_id, v.ticket, v.title, v.category, v.size, v.points, v.hours, v.status).lastInsertRowid;
    res.json(db.prepare('SELECT * FROM workloads WHERE id=?').get(id));
  } catch { bad(res, 'Nomor tiket sudah dipakai di sprint ini'); }
}));
app.put('/api/workloads/:id', auth, wrap((req, res) => {
  const w = db.prepare('SELECT * FROM workloads WHERE id=?').get(req.params.id); if (!w) return bad(res, 'Tidak ditemukan', 404);
  if (!canManage(req.user, userById(w.user_id))) return bad(res, 'Akses ditolak', 403);
  const { v, error } = cleanWorkload({ ...w, ...req.body, points: req.body.points ?? w.points }); if (error) return bad(res, error);
  db.prepare('UPDATE workloads SET ticket=?,title=?,category=?,size=?,points=?,hours=?,status=? WHERE id=?').run(v.ticket, v.title, v.category, v.size, v.points, v.hours, v.status, w.id);
  res.json(db.prepare('SELECT * FROM workloads WHERE id=?').get(w.id));
}));
app.delete('/api/workloads/:id', auth, wrap((req, res) => {
  const w = db.prepare('SELECT * FROM workloads WHERE id=?').get(req.params.id); if (!w) return bad(res, 'Tidak ditemukan', 404);
  if (!canManage(req.user, userById(w.user_id))) return bad(res, 'Akses ditolak', 403);
  db.prepare('DELETE FROM workloads WHERE id=?').run(w.id);
  res.json({ ok: true });
}));

// ---------- metrics (input manual) ----------
app.get('/api/metrics', auth, wrap((req, res) => {
  const sprint = Number(req.query.sprint); const uid = Number(req.query.user) || req.user.id;
  const target = userById(uid); if (!target || !canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  res.json({ values: S.metricsMap(uid, sprint), summary: S.memberSummary(target, sprint) });
}));
app.put('/api/metrics', auth, wrap((req, res) => {
  const { user_id, sprint_id, values } = req.body || {};
  const uid = Number(user_id) || req.user.id;
  const target = userById(uid); if (!target || !canManage(req.user, target)) return bad(res, 'Akses ditolak', 403);
  if (!target.position) return bad(res, 'Pengguna tidak punya posisi');
  const defs = Object.fromEntries(M.INPUT_METRICS[target.position].map(d => [d.key, d]));
  const isLead = req.user.role !== 'staff';
  const up = db.prepare("INSERT INTO metrics(user_id,sprint_id,key,value,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(user_id,sprint_id,key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=datetime('now')");
  const del = db.prepare('DELETE FROM metrics WHERE user_id=? AND sprint_id=? AND key=?');
  const errors = [];
  db.transaction(() => {
    for (const [k, raw] of Object.entries(values || {})) {
      const d = defs[k]; if (!d) continue;
      if (d.entry === 'lead' && !isLead) { errors.push(`${d.label}: hanya diisi Team Lead/Admin`); continue; }
      if (raw === '' || raw == null) { del.run(uid, sprint_id, k); continue; }
      const n = Number(raw);
      if (!isFinite(n) || n < 0 || (d.max != null && n > d.max)) { errors.push(`${d.label}: nilai tidak valid`); continue; }
      up.run(uid, sprint_id, k, n, req.user.id);
    }
  })();
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  res.json({ values: S.metricsMap(uid, sprint_id), summary: S.memberSummary(target, sprint_id) });
}));

// ---------- dashboard & laporan ----------
app.get('/api/dashboard', auth, wrap((req, res) => {
  const sprint = Number(req.query.sprint); if (!sprint) return bad(res, 'sprint wajib');
  const team = req.user.role === 'admin' ? Number(req.query.team) || null : req.user.team_id;
  res.json({ ...S.sprintSummary(req.user, sprint, team), trend: S.trend(req.user, team) });
}));

app.get('/api/report', auth, need('admin', 'lead'), wrap(async (req, res) => {
  const params = { sprint: Number(req.query.sprint) || null, month: req.query.month || null, team: req.user.role === 'admin' ? req.query.team : req.user.team_id };
  if (!params.sprint && !/^\d{4}-\d{2}$/.test(params.month || '')) return bad(res, 'Pilih sprint atau bulan (YYYY-MM)');
  const data = R.buildRows(req.user, params);
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
app.get('/api/integrations', auth, need('admin'), (_req, res) => res.json({ webhook_secret: getSetting('webhook_secret') }));
app.post('/api/integrations/rotate', auth, need('admin'), (_req, res) => {
  const s = crypto.randomBytes(16).toString('hex'); setSetting('webhook_secret', s); res.json({ webhook_secret: s });
});

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function activeSprint() { return db.prepare("SELECT * FROM sprints WHERE status='active' ORDER BY start_date DESC LIMIT 1").get(); }
function bump(uid, sprintId, key) {
  db.prepare("INSERT INTO metrics(user_id,sprint_id,key,value) VALUES(?,?,?,1) ON CONFLICT(user_id,sprint_id,key) DO UPDATE SET value=value+1, updated_at=datetime('now')").run(uid, sprintId, key);
}

app.post('/api/webhooks/jira', wrap((req, res) => {
  const given = req.get('x-webhook-secret') || req.query.secret || '';
  if (!safeEq(given, getSetting('webhook_secret'))) return bad(res, 'Secret tidak valid', 401);
  const issue = req.body?.issue; if (!issue?.key) return bad(res, 'Payload Jira tidak dikenali');
  const f = issue.fields || {};
  const email = f.assignee?.emailAddress; if (!email) return res.json({ ignored: 'tanpa assignee' });
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1').get(email);
  if (!u) return res.json({ ignored: 'assignee tidak terdaftar' });
  const sprint = activeSprint(); if (!sprint) return res.json({ ignored: 'tidak ada sprint aktif' });
  const type = String(f.issuetype?.name || '').toLowerCase();
  const category = type.includes('bug') ? 'bug' : type.includes('debt') ? 'techdebt' : type.includes('test') ? 'test' : 'feature';
  const cat = f.status?.statusCategory?.key; const sname = String(f.status?.name || '').toLowerCase();
  const status = cat === 'done' ? 'done' : sname.includes('review') ? 'review' : cat === 'indeterminate' ? 'in_progress' : 'todo';
  const points = Number(f.customfield_10016 ?? f.storyPoints ?? 0) || 0;
  db.prepare(`INSERT INTO workloads(user_id,sprint_id,ticket,title,category,points,status,source) VALUES(?,?,?,?,?,?,?,'jira')
    ON CONFLICT(source,ticket,sprint_id) WHERE ticket IS NOT NULL DO UPDATE SET user_id=excluded.user_id,title=excluded.title,category=excluded.category,points=excluded.points,status=excluded.status`)
    .run(u.id, sprint.id, issue.key, f.summary || issue.key, category, points, status);
  res.json({ ok: true, ticket: issue.key, status });
}));

app.post('/api/webhooks/github', wrap((req, res) => {
  const secret = getSetting('webhook_secret');
  const sig = req.get('x-hub-signature-256');
  if (sig) {
    const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    if (!safeEq(sig, exp)) return bad(res, 'Signature tidak valid', 401);
  } else if (!safeEq(req.get('x-webhook-secret') || req.query.secret || '', secret)) return bad(res, 'Secret tidak valid', 401);
  const ev = req.get('x-github-event'); const b = req.body || {};
  const sprint = activeSprint(); if (!sprint) return res.json({ ignored: 'tidak ada sprint aktif' });
  const find = login => login && db.prepare('SELECT * FROM users WHERE lower(github_username)=lower(?) AND active=1').get(login);
  if (ev === 'pull_request' && b.action === 'closed' && b.pull_request?.merged) {
    const u = find(b.pull_request.user?.login); if (u) bump(u.id, sprint.id, 'pr_count');
    return res.json({ ok: true, counted: !!u });
  }
  if (ev === 'pull_request_review' && b.action === 'submitted') {
    const u = find(b.review?.user?.login); if (u && b.review.user.login !== b.pull_request?.user?.login) bump(u.id, sprint.id, 'reviews_count');
    return res.json({ ok: true, counted: !!u });
  }
  res.json({ ignored: ev || 'event tidak didukung' });
}));

// ---------- static & error ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (_req, res) => bad(res, 'Endpoint tidak ditemukan', 404));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Terjadi kesalahan server' }); });

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Aplikasi berjalan di http://localhost:${port}`));
}
module.exports = app;
