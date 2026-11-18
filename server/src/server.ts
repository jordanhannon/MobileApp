import 'dotenv/config';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createEmailSender } from './email.js';
import { PostgresStore } from './postgresStore.js';

const config = readConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: true } : undefined,
});
const store = new PostgresStore(pool);
const app = createApp({
  config,
  store,
  emailSender: createEmailSender(config),
});

const finalizeDueBrackets = async () => {
  try {
    await store.finalizeDueBrackets();
  } catch (error) {
    app.log.error({ err: error }, 'Unable to finalize due tournament brackets.');
  }
};

const bracketSweep = setInterval(() => void finalizeDueBrackets(), 30_000);
bracketSweep.unref();

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
  void finalizeDueBrackets();
} catch (error) {
  app.log.error(error);
  clearInterval(bracketSweep);
  await pool.end();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(bracketSweep);
    void app.close().then(() => pool.end());
  });
}
