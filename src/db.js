const { Pool, types } = require('pg');

types.setTypeParser(1082, v => v); // DATE tetap berupa string 'YYYY-MM-DD'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://pwt:pwt@127.0.0.1:5432/pwt',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const q = async (sql, params = [], c = pool) => (await c.query(sql, params)).rows;
const one = async (sql, params = [], c = pool) => (await c.query(sql, params)).rows[0];

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','lead','staff')),
  position TEXT CHECK (position IN ('BA','DEV','QA')),
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  capacity INTEGER NOT NULL DEFAULT 20,
  github_username TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email));
CREATE TABLE IF NOT EXISTS sprints (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed'))
);
CREATE TABLE IF NOT EXISTS workloads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  ticket TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'feature',
  size TEXT CHECK (size IN ('S','M','L')),
  points DOUBLE PRECISION NOT NULL DEFAULT 0,
  hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','review','done','cancelled')),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_workload_ticket ON workloads(source, ticket, sprint_id) WHERE ticket IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_workload_user_sprint ON workloads(user_id, sprint_id);
CREATE TABLE IF NOT EXISTS metrics (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sprint_id, key)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

// Dipanggil sekali saat start (idempoten).
const init = () => pool.query(SCHEMA);

module.exports = { pool, q, one, tx, init };
