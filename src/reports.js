const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { q } = require('./db');
const { sprintSummary, visibleUsers } = require('./summary');
const { POSITIONS, DERIVED_LABELS, HEADLINE, CATEGORIES } = require('./metrics');

const STATUS_LABEL = { healthy: 'Sehat', busy: 'Padat', risk: 'Risiko Burnout', low: 'Kurang Terpakai', unknown: '-' };

async function sprintsFor({ sprint, month }) {
  if (sprint) return q('SELECT * FROM sprints WHERE id=$1', [sprint]);
  if (month) return q("SELECT * FROM sprints WHERE to_char(start_date,'YYYY-MM')=$1 OR to_char(end_date,'YYYY-MM')=$1 ORDER BY start_date", [month]);
  return [];
}

async function buildRows(viewer, params) {
  const rows = [];
  const sprints = await sprintsFor(params);
  for (const s of sprints) {
    const sum = await sprintSummary(viewer, s.id, params.team ? Number(params.team) : null);
    for (const r of sum.rows) {
      const metrics = HEADLINE[r.user.position].map(k => `${DERIVED_LABELS[k][0]}: ${r.metrics[k] ?? '-'}${r.metrics[k] != null ? ' ' + DERIVED_LABELS[k][1] : ''}`.trim());
      rows.push({
        sprint: s.name, name: r.user.name, position: POSITIONS[r.user.position],
        capacity: r.workload.capacity, taken: r.workload.taken, done: r.workload.done,
        load: r.workload.loadPct, status: STATUS_LABEL[r.workload.status], metrics: metrics.join('; '), raw: r.metrics, pos: r.user.position,
      });
    }
  }
  return { sprints, rows };
}

function csvEscape(v) { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function toCsv({ rows }) {
  const head = ['Sprint', 'Nama', 'Peran', 'Kapasitas', 'Diambil', 'Selesai', 'Beban (%)', 'Status Beban', 'Metrik Kinerja'];
  const lines = [head, ...rows.map(r => [r.sprint, r.name, r.position, r.capacity, r.taken, r.done, r.load, r.status, r.metrics])];
  return '﻿' + lines.map(l => l.map(csvEscape).join(',')).join('\n');
}

async function toXlsx({ sprints, rows }, viewer) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Performance & Workload Tracker';
  const ws = wb.addWorksheet('Ringkasan');
  ws.columns = [
    { header: 'Sprint', key: 'sprint', width: 16 }, { header: 'Nama', key: 'name', width: 22 }, { header: 'Peran', key: 'position', width: 18 },
    { header: 'Kapasitas', key: 'capacity', width: 11 }, { header: 'Diambil', key: 'taken', width: 10 }, { header: 'Selesai', key: 'done', width: 10 },
    { header: 'Beban (%)', key: 'load', width: 11 }, { header: 'Status Beban', key: 'status', width: 16 }, { header: 'Metrik Kinerja', key: 'metrics', width: 80 },
  ];
  rows.forEach(r => ws.addRow(r));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4B8C' } };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const st = row.getCell('status').value;
    const argb = st === 'Risiko Burnout' ? 'FFF8C9C4' : st === 'Padat' ? 'FFFFF0B8' : st === 'Sehat' ? 'FFD3EFD3' : null;
    if (argb) row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const wt = wb.addWorksheet('Detail Tugas');
  wt.columns = [
    { header: 'Sprint', key: 'sprint', width: 16 }, { header: 'Nama', key: 'name', width: 22 }, { header: 'Tiket', key: 'ticket', width: 12 },
    { header: 'Judul', key: 'title', width: 44 }, { header: 'Kategori', key: 'category', width: 24 }, { header: 'Ukuran', key: 'size', width: 8 },
    { header: 'Poin', key: 'points', width: 8 }, { header: 'Jam', key: 'hours', width: 8 }, { header: 'Status', key: 'status', width: 14 }, { header: 'Sumber', key: 'source', width: 10 },
  ];
  const ids = new Set((await visibleUsers(viewer)).map(u => u.id));
  for (const s of sprints) {
    const items = await q('SELECT w.*, u.name FROM workloads w JOIN users u ON u.id=w.user_id WHERE sprint_id=$1 ORDER BY u.name', [s.id]);
    for (const i of items) if (ids.has(i.user_id)) wt.addRow({ ...i, sprint: s.name, category: CATEGORIES[i.category] || i.category });
  }
  wt.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

function toPdf({ sprints, rows }, res) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  doc.pipe(res);
  doc.fontSize(18).text('Laporan Kinerja & Beban Kerja Tim Teknis');
  doc.fontSize(10).fillColor('#555').text(`Periode: ${sprints.map(s => s.name).join(', ') || '-'}   |   Dibuat: ${new Date().toLocaleString('id-ID')}`).moveDown();
  const cols = [['Sprint', 70], ['Nama', 110], ['Peran', 100], ['Kap.', 35], ['Diambil', 45], ['Selesai', 45], ['Beban', 45], ['Status', 85], ['Metrik Kinerja', 230]];
  const drawRow = (vals, bold, y) => {
    let x = 36;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000');
    vals.forEach((v, i) => { doc.text(String(v ?? ''), x, y, { width: cols[i][1] - 4, lineBreak: true }); x += cols[i][1]; });
  };
  let y = doc.y;
  drawRow(cols.map(c => c[0]), true, y); y += 14;
  doc.moveTo(36, y - 2).lineTo(806, y - 2).stroke('#999');
  for (const r of rows) {
    const h = Math.max(14, doc.heightOfString(r.metrics, { width: 226 }) + 4);
    if (y + h > 560) { doc.addPage(); y = 36; }
    drawRow([r.sprint, r.name, r.position, r.capacity, r.taken, r.done, r.load != null ? r.load + '%' : '-', r.status, r.metrics], false, y);
    y += h;
  }
  doc.font('Helvetica').fontSize(8).fillColor('#555').text('Catatan: batas aman beban kerja 75%-80% per siklus; >90% berisiko burnout.', 36, y + 10);
  doc.end();
}

module.exports = { buildRows, toCsv, toXlsx, toPdf };
