// Definisi metrik sesuai dokumen kerangka kerja (bagian 2-4).
// entry: 'self' = diisi anggota sendiri, 'lead' = diisi Team Lead/Admin (penilaian kualitatif/atasan),
//        'auto' = ditarik dari webhook (Jira/GitHub), tapi tetap bisa dikoreksi manual oleh lead.
const POSITIONS = { BA: 'Business Analyst', DEV: 'Developer', QA: 'QA' };

const CATEGORIES = {
  spec: 'Spesifikasi / User Story',
  feature: 'Fitur',
  bug: 'Perbaikan Bug',
  techdebt: 'Tech Debt',
  review: 'Code Review',
  test: 'Skenario / Skrip Uji',
  alignment: 'Sesi Alignment / Workshop',
  other: 'Lainnya',
};

const SIZE_POINTS = { S: 2, M: 5, L: 8 };

// Metrik input (tersimpan di tabel metrics)
const INPUT_METRICS = {
  BA: [
    { key: 'dependency_ratio', label: 'Rasio Ketergantungan (jumlah tim agile dilayani)', unit: 'tim', entry: 'lead', max: 10 },
    { key: 'alignment_sessions', label: 'Sesi Alignment / Workshop dipimpin', unit: 'sesi', entry: 'self' },
    { key: 'rework_count', label: 'Rework Spesifikasi (scope creep)', unit: 'kali', entry: 'self', lowerBetter: true },
    { key: 'ready_on_time_pct', label: 'Backlog Ready tepat waktu', unit: '%', entry: 'self', max: 100 },
    { key: 'requirement_clarity', label: 'Kejelasan Dokumentasi (skor 1-5)', unit: '/5', entry: 'lead', max: 5 },
    { key: 'stakeholder_satisfaction', label: 'Kepuasan Stakeholder (skor 1-5)', unit: '/5', entry: 'lead', max: 5 },
    { key: 'uat_findings', label: 'Temuan UAT akibat salah paham alur bisnis', unit: 'temuan', entry: 'lead', lowerBetter: true },
  ],
  DEV: [
    { key: 'pr_count', label: 'Pull Request (merged)', unit: 'PR', entry: 'auto' },
    { key: 'reviews_count', label: 'Code Review membantu rekan', unit: 'review', entry: 'auto' },
    { key: 'code_quality', label: 'Skor Kualitas Kode (SonarQube, 0-100)', unit: '', entry: 'lead', max: 100 },
    { key: 'review_revisions', label: 'Catatan revisi saat code review', unit: 'catatan', entry: 'lead', lowerBetter: true },
    { key: 'defects_escaped', label: 'Bug lolos ke staging/production (karena kode)', unit: 'bug', entry: 'lead', lowerBetter: true },
    { key: 'unit_coverage', label: 'Unit Test Coverage', unit: '%', entry: 'self', max: 100 },
  ],
  QA: [
    { key: 'tc_created', label: 'Test case dibuat', unit: 'kasus', entry: 'self' },
    { key: 'tc_executed', label: 'Test case dieksekusi', unit: 'kasus', entry: 'self' },
    { key: 'defects_found', label: 'Defect ditemukan & dikelola (sebelum rilis)', unit: 'bug', entry: 'self' },
    { key: 'defects_escaped', label: 'Defect lolos ke production', unit: 'bug', entry: 'lead', lowerBetter: true },
    { key: 'automation_scripts', label: 'Skrip otomasi baru / dipelihara', unit: 'skrip', entry: 'self' },
    { key: 'cycle_time_days', label: 'Waktu siklus regression testing', unit: 'hari', entry: 'self', lowerBetter: true },
    { key: 'report_clarity', label: 'Kejelasan Pelaporan Defect (skor 1-5)', unit: '/5', entry: 'lead', max: 5 },
    { key: 'signoff_accuracy', label: 'Ketepatan Rekomendasi Sign-off', unit: '%', entry: 'lead', max: 100 },
  ],
};

const round = (n, d = 1) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

// Menghitung beban kerja & metrik turunan dari item workload + metrik input.
function compute(user, items, m) {
  const active = items.filter(i => i.status !== 'cancelled');
  const taken = active.reduce((s, i) => s + i.points, 0);
  const done = active.filter(i => i.status === 'done').reduce((s, i) => s + i.points, 0);
  const hours = active.reduce((s, i) => s + i.hours, 0);
  const capacity = user.capacity || 0;
  const loadPct = capacity ? round((taken / capacity) * 100, 0) : null;
  const fixPoints = active.filter(i => ['bug', 'techdebt'].includes(i.category)).reduce((s, i) => s + i.points, 0);
  const count = c => active.filter(i => i.category === c).length;
  const sizeCount = s => active.filter(i => i.size === s).length;

  const workload = {
    taken, done, hours, capacity, loadPct, tasks: active.length,
    status: loadStatus(loadPct),
  };
  const k = {}; // metrik kinerja utama (nilai terhitung/terisi)
  if (user.position === 'BA') {
    k.user_stories = count('spec');
    k.complexity_sml = `${sizeCount('S')}/${sizeCount('M')}/${sizeCount('L')}`;
    for (const key of ['dependency_ratio', 'alignment_sessions', 'rework_count', 'ready_on_time_pct', 'requirement_clarity', 'stakeholder_satisfaction', 'uat_findings']) k[key] = m[key] ?? null;
  } else if (user.position === 'DEV') {
    k.velocity = done;
    k.delivery_consistency = taken ? round((done / taken) * 100, 0) : null;
    k.fix_share = taken ? round((fixPoints / taken) * 100, 0) : null;
    k.pr_count = m.pr_count ?? null;
    k.reviews_count = m.reviews_count ?? null;
    k.code_quality = m.code_quality ?? null;
    k.unit_coverage = m.unit_coverage ?? null;
    k.defects_escaped = m.defects_escaped ?? null;
    k.defect_density = m.defects_escaped != null && done ? round(m.defects_escaped / done, 2) : null; // bug per story point
  } else if (user.position === 'QA') {
    k.tc_created = m.tc_created ?? null;
    k.tc_executed = m.tc_executed ?? null;
    k.tc_exec_pct = m.tc_created ? round((m.tc_executed || 0) / m.tc_created * 100, 0) : null;
    k.defects_found = m.defects_found ?? null;
    const totalDef = (m.defects_found || 0) + (m.defects_escaped || 0);
    k.escape_defect_rate = m.defects_escaped != null && totalDef ? round((m.defects_escaped / totalDef) * 100, 1) : (m.defects_escaped === 0 ? 0 : null);
    k.automation_scripts = m.automation_scripts ?? null;
    k.cycle_time_days = m.cycle_time_days ?? null;
    k.report_clarity = m.report_clarity ?? null;
    k.signoff_accuracy = m.signoff_accuracy ?? null;
  }
  return { workload, metrics: k };
}

// Batas dari dokumen: aman 75-80%, hijau 50-79, kuning 80-90, merah >90.
function loadStatus(pct) {
  if (pct == null) return 'unknown';
  if (pct > 90) return 'risk';
  if (pct >= 80) return 'busy';
  if (pct >= 50) return 'healthy';
  return 'low';
}

const DERIVED_LABELS = {
  user_stories: ['User Story', ''], complexity_sml: ['Kompleksitas S/M/L', ''],
  velocity: ['Velocity', 'poin'], delivery_consistency: ['Konsistensi Pengiriman', '%'], fix_share: ['Porsi Bug/Tech Debt', '%'],
  defect_density: ['Defect Density', 'bug/poin'], tc_exec_pct: ['Eksekusi Test Case', '%'], escape_defect_rate: ['Escape Defect Rate', '%'],
};
for (const list of Object.values(INPUT_METRICS)) for (const d of list) DERIVED_LABELS[d.key] = DERIVED_LABELS[d.key] || [d.label, d.unit];

// Metrik yang ditampilkan di ringkasan tim per posisi
const HEADLINE = {
  BA: ['user_stories', 'ready_on_time_pct', 'requirement_clarity', 'rework_count'],
  DEV: ['velocity', 'delivery_consistency', 'code_quality', 'unit_coverage', 'defect_density'],
  QA: ['tc_exec_pct', 'escape_defect_rate', 'automation_scripts', 'signoff_accuracy'],
};

module.exports = { POSITIONS, CATEGORIES, SIZE_POINTS, INPUT_METRICS, DERIVED_LABELS, HEADLINE, compute, loadStatus, round };
