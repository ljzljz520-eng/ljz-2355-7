import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, one } from './db/index.js';
import { seedIfEmpty } from './db/seed.js';
import { api } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));

api.use((err, req, res, next) => {
  // eslint-disable-line no-unused-vars
  const st = err.status || 500;
  if (st >= 500) console.error('[API ERROR]', err);
  res.status(st).json({ error: err.message || String(err) });
});

const PORT = process.env.PORT || 3000;
initDb().then(async () => {
  await seedIfEmpty();
  app.listen(PORT, () => console.log(`硬件安装手册演示系统: http://localhost:${PORT}  (${process.env.DATABASE_URL ? 'PostgreSQL' : 'PGlite 本地持久化'})`));
}).catch(e => { console.error(e); process.exit(1); });
