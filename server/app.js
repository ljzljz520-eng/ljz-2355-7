// 硬件安装手册系统 —— 服务入口
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema } from './db/pg.js';
import { seed } from './db/seed.js';
import { api } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '12mb' }));

app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));

// 统一错误处理：把领域错误码透传给前端
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.message || '服务器内部错误',
    code: err.code || null,
    blocked_by: err.blocked_by || null,
    missing: err.missing || null,
    problems: err.problems || null,
  });
});

const port = Number(process.env.PORT || 3000);

async function bootstrap() {
  await initSchema();
  const s = await seed();
  if (!s.skipped) console.log('已从给定演示资料装载手册:', JSON.stringify(s.versions));
  else console.log('演示资料已存在，跳过装载');
  app.listen(port, () => console.log(`硬件安装手册系统: http://localhost:${port}`));
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
