const db = require('./db');
const { compute, round } = require('./metrics');

function metricsMap(userId, sprintId) {
  const m = {};
  for (const r of db.prepare('SELECT key, value FROM metrics WHERE user_id=? AND sprint_id=?').all(userId, sprintId)) m[r.key] = r.value;
  return m;
}

function memberSummary(user, sprintId) {
  const items = db.prepare('SELECT * FROM workloads WHERE user_id=? AND sprint_id=?').all(user.id, sprintId);
  const { workload, metrics } = compute(user, items, metricsMap(user.id, sprintId));
  return {
    user: { id: user.id, name: user.name, position: user.position, team_id: user.team_id, capacity: user.capacity },
    workload, metrics,
  };
}

function visibleUsers(viewer, teamId) {
  let sql = "SELECT * FROM users WHERE active=1 AND role!='admin'";
  const args = [];
  if (viewer.role === 'staff') { sql += ' AND id=?'; args.push(viewer.id); }
  else if (viewer.role === 'lead') { sql += ' AND team_id=?'; args.push(viewer.team_id); }
  else if (teamId) { sql += ' AND team_id=?'; args.push(teamId); }
  return db.prepare(sql + ' ORDER BY position, name').all(...args);
}

function sprintSummary(viewer, sprintId, teamId) {
  const rows = visibleUsers(viewer, teamId).filter(u => u.position).map(u => memberSummary(u, sprintId));
  const withLoad = rows.filter(r => r.workload.loadPct != null);
  const avgLoad = withLoad.length ? round(withLoad.reduce((s, r) => s + r.workload.loadPct, 0) / withLoad.length, 0) : null;
  const qa = rows.filter(r => r.user.position === 'QA');
  const dev = rows.filter(r => r.user.position === 'DEV');
  const ba = rows.filter(r => r.user.position === 'BA');
  const avg = (list, f) => {
    const v = list.map(f).filter(x => x != null);
    return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 1) : null;
  };
  const escaped = rows.reduce((s, r) => s + (r.metrics.defects_escaped || 0), 0);
  return {
    rows,
    totals: {
      avgLoad,
      atRisk: rows.filter(r => r.workload.status === 'risk').length,
      escapedBugs: escaped,
      baReadyPct: avg(ba, r => r.metrics.ready_on_time_pct),
      devVelocity: dev.reduce((s, r) => s + (r.metrics.velocity || 0), 0),
      devCoverage: avg(dev, r => r.metrics.unit_coverage),
      devQuality: avg(dev, r => r.metrics.code_quality),
      qaEscapeRate: avg(qa, r => r.metrics.escape_defect_rate),
      baRework: avg(ba, r => r.metrics.rework_count),
    },
  };
}

function trend(viewer, teamId, limit = 6) {
  const sprints = db.prepare('SELECT * FROM sprints ORDER BY start_date DESC LIMIT ?').all(limit).reverse();
  return sprints.map(s => {
    const t = sprintSummary(viewer, s.id, teamId).totals;
    return { sprint: s.name, id: s.id, avgLoad: t.avgLoad, velocity: t.devVelocity, escapedBugs: t.escapedBugs };
  });
}

module.exports = { memberSummary, sprintSummary, visibleUsers, trend, metricsMap };
