import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { readConfig } from './config.js';

const config = readConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

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
    const applied = await client.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      ['001_initial'],
    );
    if (applied.rowCount === 0) {
      const migration = await readFile(resolve(process.cwd(), 'migrations', '001_initial.sql'), 'utf8');
      await client.query(migration);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_initial']);
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
