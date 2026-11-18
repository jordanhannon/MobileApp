import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { readConfig } from './config.js';

const config = readConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const migrations = [
  ['001_initial', '001_initial.sql'],
  ['002_rbac_events', '002_rbac_events.sql'],
  ['003_recurring_events', '003_recurring_events.sql'],
  ['004_social_auth', '004_social_auth.sql'],
  ['005_tournament_brackets', '005_tournament_brackets.sql'],
  ['006_bracket_cutoffs_guests', '006_bracket_cutoffs_guests.sql'],
] as const;

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    for (const [version, filename] of migrations) {
      const applied = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (applied.rowCount === 0) {
        const migration = await readFile(resolve(process.cwd(), 'migrations', filename), 'utf8');
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      }
    }
    await client.query('COMMIT');
    console.info('Database migrations are up to date.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
