// Mengisi data demo. Jalankan: npm run seed  (hanya jika database masih kosong, atau dengan --force)
const bcrypt = require('bcryptjs');
const db = require('./db');
const { SIZE_POINTS } = require('./metrics');

if (db.prepare('SELECT COUNT(*) c FROM users').get().c && !process.argv.includes('--force')) {
  console.log('Database sudah berisi data. Gunakan --force untuk menambah ulang.'); process.exit(0);
}
const pw = bcrypt.hashSync(process.env.SEED_PASSWORD || 'password123', 10);
const team = db.prepare('INSERT INTO teams(name) VALUES(?)').run('Tim Alpha').lastInsertRowid;
const user = (name, email, role, position, capacity, gh) =>
  db.prepare('INSERT INTO users(name,email,password_hash,role,position,team_id,capacity,github_username) VALUES(?,?,?,?,?,?,?,?)')
    .run(name, email, pw, role, position, role === 'admin' ? null : team, capacity, gh || null).lastInsertRowid;

user('Admin HR', 'admin@example.com', 'admin', null, 20);
user('Rina Lead', 'lead@example.com', 'lead', null, 20);
const ba = user('Sarah Amalia', 'sarah@example.com', 'staff', 'BA', 20);
const d1 = user('Budi Santoso', 'budi@example.com', 'staff', 'DEV', 20, 'budi-dev');
const d2 = user('Andi Pratama', 'andi@example.com', 'staff', 'DEV', 20, 'andi-dev');
const qa = user('Siska Dewi', 'siska@example.com', 'staff', 'QA', 20);

const sprints = [['Sprint #10', '2026-08-03', '2026-08-16', 'closed'], ['Sprint #11', '2026-08-17', '2026-08-30', 'closed'], ['Sprint #12', '2026-08-31', '2026-09-13', 'active']]
  .map(s => db.prepare('INSERT INTO sprints(name,start_date,end_date,status) VALUES(?,?,?,?)').run(...s).lastInsertRowid);

const Wst = db.prepare('INSERT INTO workloads(user_id,sprint_id,ticket,title,category,size,points,hours,status) VALUES(?,?,?,?,?,?,?,?,?)');
const W = (...a) => Wst.run(...a);
const Mt = db.prepare('INSERT INTO metrics(user_id,sprint_id,key,value) VALUES(?,?,?,?)');
const set = (u, s, o) => Object.entries(o).forEach(([k, v]) => Mt.run(u, s, k, v));

sprints.forEach((s, i) => {
  const last = i === 2;
  // BA
  [['PRD Checkout', 'L'], ['Story: Voucher', 'M'], ['Story: Refund', 'M'], ['Story: Notifikasi', 'S']].forEach(([t, z], j) =>
    W(ba, s, `BA-${i}${j}`, t, 'spec', z, SIZE_POINTS[z] + (i === 2 ? 0 : 1), 6, last && j > 1 ? 'in_progress' : 'done'));
  set(ba, s, { dependency_ratio: 1, alignment_sessions: 4 + i, rework_count: 3 - i, ready_on_time_pct: 85 + i * 5, requirement_clarity: 3.5 + i * 0.5, stakeholder_satisfaction: 4, uat_findings: 2 - i });
  // DEV
  const budiPts = [[8, 'feature'], [5, 'bug'], [5, 'feature'], [i === 2 ? 1 : 3, 'techdebt']];
  budiPts.forEach(([p, c], j) => W(d1, s, `DEV-${i}0${j}`, `Tugas Budi ${j + 1}`, c, null, p, p * 3, last && j > 0 ? ['in_progress', 'review', 'todo'][j - 1] : 'done'));
  set(d1, s, { pr_count: 8 + i, reviews_count: 5, code_quality: 78 + i * 3, review_revisions: 6 - i, defects_escaped: 1, unit_coverage: 70 + i * 4 });
  [[5, 'feature'], [5, 'feature'], [4, 'bug']].forEach(([p, c], j) => W(d2, s, `DEV-${i}1${j}`, `Tugas Andi ${j + 1}`, c, null, p, p * 3, last && j === 2 ? 'in_progress' : 'done'));
  set(d2, s, { pr_count: 6 + i, reviews_count: 7, code_quality: 82, review_revisions: 3, defects_escaped: 0, unit_coverage: 80 + i * 2 });
  // QA
  [['Regression suite', 'test', 5], ['Smoke checkout', 'test', 3], ['Automasi login', 'test', 5], ['Verifikasi bug', 'bug', 2]].forEach(([t, c, p], j) =>
    W(qa, s, `QA-${i}${j}`, t, c, null, p, p * 3, last && j > 1 ? 'in_progress' : 'done'));
  set(qa, s, { tc_created: 40 + i * 5, tc_executed: 36 + i * 6, defects_found: 18 - i * 2, defects_escaped: 2 - (i > 0 ? 1 : 0) - (i > 1 ? 1 : 0), automation_scripts: 5 + i, cycle_time_days: 3 - (i > 1 ? 1 : 0), report_clarity: 4.5, signoff_accuracy: 90 + i * 3 });
});
console.log('Seed selesai. Akun demo (kata sandi: password123): admin@example.com, lead@example.com, sarah@example.com, budi@example.com, andi@example.com, siska@example.com');
