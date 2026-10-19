'use strict';
const $app = document.getElementById('app');
const S = { me: null, meta: null, sprints: [], sprint: null, team: '', teams: [] };

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = { admin: 'Admin', lead: 'Team Lead', staff: 'Staff' };
const STATUS = { healthy: 'Sehat', busy: 'Padat', risk: 'Risiko Burnout', low: 'Kurang Terpakai', unknown: '-' };
const TASK_STATUS = { todo: 'To Do', in_progress: 'In Progress', review: 'In Review', done: 'Done', cancelled: 'Batal' };

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401 && path !== '/login') { S.me = null; render(); throw new Error('Sesi berakhir'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Gagal');
  return data;
}
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.background = bad ? '#b3302a' : '#222'; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const isLead = () => S.me.role !== 'staff';
const fmt = (v, unit) => v == null ? '–' : `${v}${unit === '%' ? '%' : ''}`;
function loadBar(w) {
  const pct = w.loadPct ?? 0;
  return `<div class="row" style="flex-wrap:nowrap"><div class="bar ${w.status}" title="${esc(STATUS[w.status])}"><i style="width:${Math.min(pct, 100)}%"></i></div><span class="num">${w.loadPct ?? '–'}%</span></div>`;
}
const tag = st => `<span class="tag ${st}">${esc(STATUS[st])}</span>`;
function sprintOptions(sel) { return S.sprints.map(s => `<option value="${s.id}" ${s.id == sel ? 'selected' : ''}>${esc(s.name)}${s.status === 'active' ? ' (aktif)' : ''}</option>`).join(''); }

// ---------- chart sederhana (SVG) ----------
function barChart(data, { max, unit = '', colors = ['#2f4b8c'], keys }) {
  const W = 560, H = 190, p = { l: 34, r: 8, t: 10, b: 28 };
  const top = max || Math.max(10, ...data.flatMap(d => keys.map(k => d[k] || 0))) * 1.15;
  const bw = (W - p.l - p.r) / data.length;
  const gw = Math.min(46, bw * 0.7) / keys.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="grafik">`;
  [0, .5, 1].forEach(f => { const y = p.t + (H - p.t - p.b) * (1 - f); s += `<line x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}" stroke="currentColor" opacity=".12"/><text x="${p.l - 5}" y="${y + 4}" text-anchor="end">${Math.round(top * f)}${unit}</text>`; });
  if (unit === '%') { const y = p.t + (H - p.t - p.b) * (1 - 80 / top); s += `<line x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}" stroke="#c98a00" stroke-dasharray="4 3"/><text x="${W - p.r}" y="${y - 3}" text-anchor="end">batas aman 80%</text>`; }
  data.forEach((d, i) => {
    const x0 = p.l + i * bw + (bw - gw * keys.length) / 2;
    keys.forEach((k, j) => {
      const v = d[k] || 0, h = (H - p.t - p.b) * Math.min(v, top) / top;
      s += `<rect x="${x0 + j * gw}" y="${H - p.b - h}" width="${gw - 2}" height="${h}" rx="3" fill="${colors[j]}"><title>${esc(d.label)}: ${v}${unit}</title></rect>`;
    });
    s += `<text x="${p.l + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return s + '</svg>';
}

// ---------- shell ----------
function nav() {
  const items = [['dashboard', 'Dashboard'], ['work', isLead() ? 'Beban & Metrik Anggota' : 'Tugas & Metrik Saya']];
  if (isLead()) items.push(['sprints', 'Sprint'], ['reports', 'Laporan']);
  if (S.me.role === 'admin') items.push(['users', 'Pengguna & Tim'], ['integrations', 'Integrasi']);
  items.push(['account', 'Akun']);
  const cur = (location.hash.slice(2) || 'dashboard').split('?')[0];
  return `<header><div class="logo">📊 Performance & Workload</div><nav>${items.map(([k, l]) => `<a href="#/${k}" class="${cur === k ? 'on' : ''}">${l}</a>`).join('')}</nav>
  <div class="who"><select id="sprintSel" title="Sprint">${sprintOptions(S.sprint)}</select><span>${esc(S.me.name)} · ${ROLE[S.me.role]}${S.me.position ? ' · ' + S.me.position : ''}</span><button id="logout" class="s">Keluar</button></div></header>`;
}

async function render() {
  if (!S.me) return renderLogin();
  if (!S.meta) {
    [S.meta, S.sprints, S.teams] = await Promise.all([api('/meta'), api('/sprints'), api('/teams')]);
    S.sprint = Number(localStorage.getItem('sprint')) || (S.sprints.find(s => s.status === 'active') || S.sprints[0] || {}).id;
    if (!S.sprints.some(s => s.id === S.sprint)) S.sprint = (S.sprints[0] || {}).id;
  }
  const page = (location.hash.slice(2) || 'dashboard').split('?')[0];
  const fn = PAGES[page] || PAGES.dashboard;
  $app.innerHTML = nav() + '<main id="main"></main>';
  document.getElementById('sprintSel').onchange = e => { S.sprint = Number(e.target.value); try { localStorage.setItem('sprint', S.sprint); } catch {} render(); };
  document.getElementById('logout').onclick = async () => { await api('/logout', { method: 'POST' }); S.me = S.meta = null; render(); };
  try { await fn(document.getElementById('main')); } catch (e) { document.getElementById('main').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
}

function renderLogin() {
  $app.innerHTML = `<div class="login"><h1>Performance & Workload Tracker</h1><p class="sub" style="text-align:center">Pengukuran kinerja & beban kerja tim BA, Developer, QA</p>
  <form class="card" id="lf"><div><label>Email</label><input name="email" type="email" required autofocus></div><div><label>Kata sandi</label><input name="password" type="password" required></div>
  <div class="err" id="le"></div><button class="p">Masuk</button></form></div>`;
  document.getElementById('lf').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { S.me = await api('/login', { method: 'POST', body: f }); S.meta = null; location.hash = '#/dashboard'; render(); }
    catch (err) { document.getElementById('le').textContent = err.message; }
  };
}

// ---------- pages ----------
const PAGES = {};

PAGES.dashboard = async main => {
  if (!S.sprint) return main.innerHTML = '<div class="alert">Belum ada sprint. Buat sprint terlebih dahulu.</div>';
  const team = S.me.role === 'admin' ? S.team : '';
  const d = await api(`/dashboard?sprint=${S.sprint}${team ? '&team=' + team : ''}`);
  const t = d.totals, L = S.meta.labels;
  const risky = d.rows.filter(r => r.workload.status === 'risk');
  const busy = d.rows.filter(r => r.workload.status === 'busy');
  const sName = (S.sprints.find(s => s.id === S.sprint) || {}).name;
  main.innerHTML = `<div class="row"><div><h1>${isLead() ? 'Dashboard Tim' : 'Dashboard Saya'}</h1><p class="sub">Ringkasan ${esc(sName)}</p></div><div class="sp"></div>
  ${S.me.role === 'admin' ? `<div style="min-width:180px"><label>Filter Tim</label><select id="teamSel"><option value="">Semua tim</option>${S.teams.map(x => `<option value="${x.id}" ${x.id == S.team ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>` : ''}</div>
  <div class="grid g3">
   <div class="card kpi"><div class="l">${isLead() ? 'Rata-rata beban tim' : 'Beban saya'}</div><div class="v">${t.avgLoad ?? '–'}%</div>${t.avgLoad != null ? tag(window.loadStatusOf(t.avgLoad)) : ''}</div>
   ${isLead() ? `<div class="card kpi"><div class="l">Anggota berisiko burnout (&gt;90%)</div><div class="v">${t.atRisk}</div></div>` : ''}
   <div class="card kpi"><div class="l">Bug lolos ke production</div><div class="v">${t.escapedBugs}</div></div>
   <div class="card kpi"><div class="l">Velocity Developer</div><div class="v">${t.devVelocity}</div><span class="muted">story points selesai</span></div>
   <div class="card kpi"><div class="l">BA – Backlog ready tepat waktu</div><div class="v">${t.baReadyPct ?? '–'}%</div></div>
   <div class="card kpi"><div class="l">QA – Escape defect rate</div><div class="v">${t.qaEscapeRate ?? '–'}%</div></div>
  </div>
  ${risky.map(r => `<div class="alert bad">⚠ <b>${esc(r.user.name)}</b> mendekati batas burnout (${r.workload.loadPct}%). Pertimbangkan redistribusi tugas.</div>`).join('')}
  ${busy.length ? `<div class="alert">${busy.map(r => esc(r.user.name) + ' (' + r.workload.loadPct + '%)').join(', ')} berada di atas batas aman 75–80%.</div>` : ''}
  <h2>Beban Kerja & Kinerja Anggota per Peran</h2>
  <div class="tw"><table><thead><tr><th>Peran</th><th>Anggota</th><th>Beban (diambil / kapasitas)</th><th>Beban</th><th>Metrik Kinerja Utama</th></tr></thead><tbody>
  ${d.rows.map(r => `<tr class="click" data-u="${r.user.id}"><td>${r.user.position}</td><td>${esc(r.user.name)}</td><td class="num">${r.workload.taken} / ${r.workload.capacity} poin</td><td>${loadBar(r.workload)}</td>
   <td>${S.meta.headline[r.user.position].map(k => `<span class="muted">${esc(L[k][0])}:</span> <b>${fmt(r.metrics[k], L[k][1])}</b>`).join(' &nbsp;·&nbsp; ')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada anggota.</td></tr>'}
  </tbody></table></div>
  <h2>Tren Beban Kerja & Velocity (6 sprint terakhir)</h2>
  <div class="grid g2"><div class="card"><b>Rata-rata beban (%)</b>${barChart(d.trend.map(x => ({ label: x.sprint.replace(/^Sprint\s*#?/, '#'), v: x.avgLoad })), { max: 100, unit: '%', keys: ['v'], colors: ['#2f4b8c'] })}</div>
  <div class="card"><b>Velocity Developer & bug lolos</b>${barChart(d.trend.map(x => ({ label: x.sprint.replace(/^Sprint\s*#?/, '#'), v: x.velocity, b: x.escapedBugs })), { keys: ['v', 'b'], colors: ['#2e9d57', '#d03b34'] })}<div class="legend"><span style="--c:#2e9d57">Velocity</span><span style="--c:#d03b34">Bug lolos</span></div></div></div>`;
  main.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => { location.hash = `#/work?user=${tr.dataset.u}`; });
  const ts = document.getElementById('teamSel'); if (ts) ts.onchange = () => { S.team = ts.value; render(); };
};
window.loadStatusOf = p => p > 90 ? 'risk' : p >= 80 ? 'busy' : p >= 50 ? 'healthy' : 'low';

PAGES.work = async main => {
  if (!S.sprint) return main.innerHTML = '<div class="alert">Belum ada sprint.</div>';
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let users = (await api('/users')).filter(u => u.position && u.active);
  let uid = Number(qs.get('user')) || (S.me.position ? S.me.id : users[0]?.id);
  if (!users.some(u => u.id === uid)) uid = users[0]?.id;
  const user = users.find(u => u.id === uid);
  if (!user) return main.innerHTML = '<div class="alert">Tidak ada anggota dengan posisi BA/Developer/QA.</div>';
  const [items, mt] = await Promise.all([api(`/workloads?sprint=${S.sprint}&user=${uid}`), api(`/metrics?sprint=${S.sprint}&user=${uid}`)]);
  const w = mt.summary.workload, defs = S.meta.inputMetrics[user.position], L = S.meta.labels;
  const cats = S.meta.categories;
  main.innerHTML = `<div class="row"><div><h1>${esc(user.name)} <span class="muted">(${S.meta.positions[user.position]})</span></h1><p class="sub">Kapasitas ${w.capacity} poin · diambil ${w.taken} · selesai ${w.done} · ${w.hours} jam</p></div><div class="sp"></div>
  ${isLead() ? `<div style="min-width:220px"><label>Anggota</label><select id="uSel">${users.map(u => `<option value="${u.id}" ${u.id === uid ? 'selected' : ''}>${esc(u.name)} (${u.position})</option>`).join('')}</select></div>` : ''}</div>
  <div class="card"><div class="row"><b>Status beban</b>${tag(w.status)}<div class="sp"></div><div style="min-width:240px">${loadBar(w)}</div></div>
  ${w.status === 'risk' ? '<div class="alert bad">Beban melebihi 90% – risiko burnout. Disarankan batas aman 75–80% per siklus.</div>' : w.status === 'busy' ? '<div class="alert">Beban di atas batas aman 75–80%; sisakan ruang untuk tugas darurat.</div>' : ''}</div>
  <h2>Daftar Tugas</h2>
  <div class="tw"><table><thead><tr><th>Tiket</th><th>Judul</th><th>Kategori</th><th>Ukuran</th><th>Poin</th><th>Jam</th><th>Status</th><th>Sumber</th><th></th></tr></thead><tbody>
  ${items.map(i => `<tr data-id="${i.id}"><td>${esc(i.ticket || '')}</td><td>${esc(i.title)}</td><td>${esc(cats[i.category] || i.category)}</td><td>${i.size || '–'}</td><td class="num">${i.points}</td><td class="num">${i.hours}</td>
   <td><select class="st">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}" ${k === i.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td><td>${esc(i.source)}</td><td><button class="s d del">Hapus</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">Belum ada tugas pada sprint ini.</td></tr>'}
  </tbody></table></div>
  <h2>Catat Tugas / Beban Manual</h2>
  <form class="card form" id="wf">
   <div><label>Tiket (opsional)</label><input name="ticket" placeholder="DEV-101"></div>
   <div style="grid-column:span 2"><label>Judul *</label><input name="title" required></div>
   <div><label>Kategori</label><select name="category">${Object.entries(cats).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
   <div><label>Ukuran (S/M/L)</label><select name="size"><option value="">–</option><option>S</option><option>M</option><option>L</option></select></div>
   <div><label>Story Points</label><input name="points" type="number" min="0" step="0.5" placeholder="otomatis dari ukuran"></div>
   <div><label>Jam alokasi</label><input name="hours" type="number" min="0" step="0.5"></div>
   <div><label>Status</label><select name="status">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
   <button class="p">Tambah</button></form>
  <h2>Metrik Kinerja</h2>
  <div class="grid g3" style="margin-bottom:14px">${Object.entries(mt.summary.metrics).map(([k, v]) => `<div class="card kpi"><div class="l">${esc(L[k]?.[0] || k)}</div><div class="v">${fmt(v, L[k]?.[1])}</div><span class="muted">${esc(L[k]?.[1] && L[k][1] !== '%' ? L[k][1] : '')}</span></div>`).join('')}</div>
  <form class="card" id="mf"><div class="form">${defs.map(d => {
    const locked = d.entry === 'lead' && !isLead();
    return `<div><label>${esc(d.label)}${d.entry === 'lead' ? ' 🔒 Team Lead' : d.entry === 'auto' ? ' ⚙ webhook/manual' : ''}</label><input name="${d.key}" type="number" min="0" ${d.max ? `max="${d.max}"` : ''} step="any" value="${mt.values[d.key] ?? ''}" ${locked ? 'disabled' : ''}></div>`;
  }).join('')}</div><div class="row" style="margin-top:12px"><button class="p">Simpan Metrik</button><span class="muted">Escape defect rate, defect density, velocity, dsb dihitung otomatis.</span></div></form>`;

  const u = document.getElementById('uSel'); if (u) u.onchange = () => { location.hash = `#/work?user=${u.value}`; };
  document.getElementById('wf').onsubmit = guard(async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target)); b.user_id = uid; b.sprint_id = S.sprint;
    await api('/workloads', { method: 'POST', body: b }); toast('Tugas ditambahkan'); render();
  });
  main.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.querySelector('.st').onchange = guard(async e => { await api(`/workloads/${tr.dataset.id}`, { method: 'PUT', body: { status: e.target.value } }); toast('Status diperbarui'); render(); });
    tr.querySelector('.del').onclick = guard(async () => { if (confirm('Hapus tugas ini?')) { await api(`/workloads/${tr.dataset.id}`, { method: 'DELETE' }); render(); } });
  });
  document.getElementById('mf').onsubmit = guard(async e => {
    e.preventDefault();
    const values = {}; new FormData(e.target).forEach((v, k) => { values[k] = v; });
    await api('/metrics', { method: 'PUT', body: { user_id: uid, sprint_id: S.sprint, values } }); toast('Metrik disimpan'); render();
  });
};

PAGES.sprints = async main => {
  S.sprints = await api('/sprints');
  main.innerHTML = `<h1>Sprint / Siklus</h1><p class="sub">Kelola periode evaluasi.</p>
  <div class="tw"><table><thead><tr><th>Nama</th><th>Mulai</th><th>Selesai</th><th>Status</th></tr></thead><tbody>
  ${S.sprints.map(s => `<tr data-id="${s.id}"><td>${esc(s.name)}</td><td>${s.start_date}</td><td>${s.end_date}</td><td><select class="ss">${['planned', 'active', 'closed'].map(k => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${{ planned: 'Direncanakan', active: 'Aktif', closed: 'Selesai' }[k]}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>
  <h2>Sprint Baru</h2><form class="card form" id="sf"><div><label>Nama</label><input name="name" required placeholder="Sprint #13"></div><div><label>Mulai</label><input type="date" name="start_date" required></div><div><label>Selesai</label><input type="date" name="end_date" required></div><div><label>Status</label><select name="status"><option value="planned">Direncanakan</option><option value="active">Aktif</option></select></div><button class="p">Buat</button></form>`;
  main.querySelectorAll('.ss').forEach(sel => sel.onchange = guard(async () => { await api(`/sprints/${sel.closest('tr').dataset.id}`, { method: 'PUT', body: { status: sel.value } }); toast('Diperbarui'); }));
  document.getElementById('sf').onsubmit = guard(async e => {
    e.preventDefault();
    const s = await api('/sprints', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    S.sprints = await api('/sprints'); S.sprint = s.id; render();
  });
};

PAGES.reports = async main => {
  const month = new Date().toISOString().slice(0, 7);
  const link = (fmtName, q) => `/api/report?${q}&format=${fmtName}${S.me.role === 'admin' && S.team ? '&team=' + S.team : ''}`;
  main.innerHTML = `<h1>Laporan & Ekspor</h1><p class="sub">Unduh laporan per sprint atau bulanan untuk evaluasi manajemen.</p>
  <div class="grid g2"><div class="card"><b>Per sprint</b><p class="muted">${esc((S.sprints.find(s => s.id === S.sprint) || {}).name || '')}</p>
   <div class="row"><a class="btn" href="${link('xlsx', 'sprint=' + S.sprint)}">📥 Excel</a><a class="btn" href="${link('pdf', 'sprint=' + S.sprint)}">📥 PDF</a><a class="btn" href="${link('csv', 'sprint=' + S.sprint)}">📥 CSV</a></div></div>
   <div class="card"><b>Bulanan</b><p><input type="month" id="mo" value="${month}" style="max-width:200px"></p>
   <div class="row"><a class="btn" id="mx" href="#">📥 Excel</a><a class="btn" id="mp" href="#">📥 PDF</a><a class="btn" id="mc" href="#">📥 CSV</a></div></div></div>`;
  const upd = () => { const m = document.getElementById('mo').value; ['x:xlsx', 'p:pdf', 'c:csv'].forEach(p => { const [i, f] = p.split(':'); document.getElementById('m' + i).href = link(f, 'month=' + m); }); };
  document.getElementById('mo').onchange = upd; upd();
};

PAGES.users = async main => {
  const [users, teams] = await Promise.all([api('/users'), api('/teams')]); S.teams = teams;
  const tn = id => teams.find(t => t.id === id)?.name || '–';
  const teamSel = (n, v) => `<select name="${n}"><option value="">–</option>${teams.map(t => `<option value="${t.id}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
  main.innerHTML = `<h1>Pengguna & Tim</h1><p class="sub">Role-Based Access Control: Admin (Manajer/HR/Scrum Master), Team Lead (satu tim), Staff (BA/Developer/QA – data sendiri).</p>
  <div class="tw"><table><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Posisi</th><th>Tim</th><th>Kapasitas</th><th>GitHub</th><th>Aktif</th><th></th></tr></thead><tbody>
  ${users.map(u => `<tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${ROLE[u.role]}</td><td>${u.position || '–'}</td><td>${esc(tn(u.team_id))}</td><td>${u.capacity}</td><td>${esc(u.github_username || '')}</td><td>${u.active ? '✔' : '✖'}</td>
   <td><button class="s ed">Ubah</button> <button class="s tg">${u.active ? 'Nonaktifkan' : 'Aktifkan'}</button></td></tr>`).join('')}</tbody></table></div>
  <h2 id="ftitle">Tambah Pengguna</h2>
  <form class="card form" id="uf"><input type="hidden" name="id">
   <div><label>Nama *</label><input name="name" required></div><div><label>Email *</label><input name="email" type="email" required></div>
   <div><label>Kata sandi (min 8)</label><input name="password" type="password" minlength="8"></div>
   <div><label>Peran</label><select name="role"><option value="staff">Staff</option><option value="lead">Team Lead</option><option value="admin">Admin</option></select></div>
   <div><label>Posisi (Staff)</label><select name="position"><option value="">–</option><option>BA</option><option>DEV</option><option>QA</option></select></div>
   <div><label>Tim</label>${teamSel('team_id')}</div><div><label>Kapasitas (poin/sprint)</label><input name="capacity" type="number" min="1" value="20"></div>
   <div><label>Username GitHub</label><input name="github_username"></div><button class="p">Simpan</button></form>
  <h2>Tim</h2><form class="row" id="tf"><input name="name" placeholder="Nama tim baru" required style="max-width:240px"><button class="p">Tambah Tim</button></form>
  <div class="row" style="margin-top:10px">${teams.map(t => `<span class="tag todo">${esc(t.name)} <a href="#" data-t="${t.id}" class="dt" title="Hapus">✖</a></span>`).join('')}</div>`;
  const f = document.getElementById('uf');
  main.querySelectorAll('.ed').forEach(b => b.onclick = () => {
    const u = users.find(x => x.id == b.closest('tr').dataset.id);
    for (const k of ['id', 'name', 'email', 'role', 'position', 'team_id', 'capacity', 'github_username']) f.elements[k].value = u[k] ?? '';
    f.elements.password.value = ''; document.getElementById('ftitle').textContent = 'Ubah Pengguna (kosongkan kata sandi bila tidak diganti)'; f.scrollIntoView();
  });
  main.querySelectorAll('.tg').forEach(b => b.onclick = guard(async () => { const u = users.find(x => x.id == b.closest('tr').dataset.id); await api(`/users/${u.id}`, { method: 'PUT', body: { active: !u.active } }); render(); }));
  f.onsubmit = guard(async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(f)); const id = b.id; delete b.id; if (!b.password) delete b.password;
    await api(id ? `/users/${id}` : '/users', { method: id ? 'PUT' : 'POST', body: b }); toast('Tersimpan'); render();
  });
  document.getElementById('tf').onsubmit = guard(async e => { e.preventDefault(); await api('/teams', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); render(); });
  main.querySelectorAll('.dt').forEach(a => a.onclick = guard(async e => { e.preventDefault(); if (confirm('Hapus tim? Anggota akan tanpa tim.')) { await api(`/teams/${a.dataset.t}`, { method: 'DELETE' }); render(); } }));
};

PAGES.integrations = async main => {
  const { webhook_secret: sec } = await api('/integrations');
  const base = location.origin;
  main.innerHTML = `<h1>Integrasi Pihak Ketiga</h1><p class="sub">Tarik data otomatis dari Jira (story points, status, bug) dan GitHub (PR, review) lewat webhook. Data masuk ke sprint yang berstatus <b>Aktif</b>.</p>
  <div class="card"><label>Webhook secret</label><div class="row"><code id="sec">${esc(sec)}</code><button id="rot" class="s">Buat ulang</button></div></div>
  <h2>Jira</h2><div class="card"><p>Di Jira: Settings → System → WebHooks, event <i>Issue created/updated</i>, URL:</p><code>${base}/api/webhooks/jira?secret=${esc(sec)}</code>
  <p class="muted">Issue dicocokkan dengan pengguna lewat <b>email assignee</b>. Story points dibaca dari <code>customfield_10016</code>. Tipe Bug→Perbaikan Bug, status category Done→Done.</p></div>
  <h2>GitHub</h2><div class="card"><p>Di repositori: Settings → Webhooks, content type <code>application/json</code>, event <i>Pull requests</i> &amp; <i>Pull request reviews</i>, secret di atas, URL:</p><code>${base}/api/webhooks/github</code>
  <p class="muted">PR yang di-<i>merge</i> menambah <i>PR count</i>, review menambah <i>review count</i>, dicocokkan lewat <b>username GitHub</b> pengguna. Signature HMAC-SHA256 diverifikasi.</p></div>`;
  document.getElementById('rot').onclick = guard(async () => { if (confirm('Secret lama akan tidak berlaku. Lanjut?')) { await api('/integrations/rotate', { method: 'POST' }); render(); } });
};

PAGES.account = async main => {
  main.innerHTML = `<h1>Akun</h1><p class="sub">${esc(S.me.email)}</p><form class="card form" id="pf" style="max-width:520px"><div><label>Kata sandi saat ini</label><input type="password" name="current" required></div><div><label>Kata sandi baru (min 8)</label><input type="password" name="next" minlength="8" required></div><button class="p">Ganti</button></form>`;
  document.getElementById('pf').onsubmit = guard(async e => { e.preventDefault(); await api('/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Kata sandi diganti'); });
};

window.addEventListener('hashchange', render);
api('/me').then(u => { S.me = u; }).catch(() => {}).finally(render);
