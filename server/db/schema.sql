-- ============================================================================
-- 硬件安装手册系统  PostgreSQL schema
-- 版本化手册(演示资料) + 安装实例(锁定版本) + 步骤执行 + 证据 + 复核 + 迁移
-- ============================================================================

-- 手册版本：给定演示资料的发布单元
CREATE TABLE IF NOT EXISTS manual_versions (
  id              SERIAL PRIMARY KEY,
  manual_code     TEXT NOT NULL,          -- 手册编号，例如 HW-CTRLBOX
  version_label   TEXT NOT NULL,          -- 资料版本，例如 v1.0 / v1.1
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','superseded','withdrawn')),
  superseded_by   INTEGER REFERENCES manual_versions(id),
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at    TIMESTAMPTZ,
  withdraw_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manual_code, version_label)
);

-- 步骤定义（版本内快照，immutable：发布后不改写，只能发新版本）
CREATE TABLE IF NOT EXISTS steps (
  id              SERIAL PRIMARY KEY,
  manual_version  INTEGER NOT NULL REFERENCES manual_versions(id),
  step_key        TEXT NOT NULL,          -- 版本内稳定键，例如 S30
  title           TEXT NOT NULL,
  detail_md       TEXT NOT NULL DEFAULT '',
  -- 适用条件：在实例上下文 (model, hw_revision, options) 上判定
  condition_expr  TEXT,                   -- 可空 = 无条件适用
  drawing_key     TEXT,                   -- 图纸键 -> objects 表
  seq_no          INTEGER NOT NULL,       -- 展示顺序（DAG 之外的阅读序）
  kind            TEXT NOT NULL DEFAULT 'task'
                    CHECK (kind IN ('task','decision','warning')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manual_version, step_key)
);

-- 步骤依赖（版本内 DAG 边）
CREATE TABLE IF NOT EXISTS step_dependencies (
  id              SERIAL PRIMARY KEY,
  manual_version  INTEGER NOT NULL REFERENCES manual_versions(id),
  step_key        TEXT NOT NULL,          -- 后继
  depends_on_key  TEXT NOT NULL,          -- 前驱
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manual_version, step_key, depends_on_key),
  CHECK (step_key <> depends_on_key)
);

-- 警示：紧邻其适用步骤（按步骤条件 + 警示条件共同生效）
CREATE TABLE IF NOT EXISTS warnings (
  id              SERIAL PRIMARY KEY,
  manual_version  INTEGER NOT NULL REFERENCES manual_versions(id),
  step_key        TEXT NOT NULL,          -- 紧邻的步骤
  code            TEXT NOT NULL,
  message         TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'caution'
                    CHECK (severity IN ('caution','warning','danger')),
  condition_expr  TEXT,                   -- 额外适用条件，可空
  UNIQUE (manual_version, step_key, code)
);

-- 图纸/图片对象元数据（对象库存图；字节存对象存储）
CREATE TABLE IF NOT EXISTS objects (
  id              SERIAL PRIMARY KEY,
  object_key      TEXT NOT NULL UNIQUE,   -- 例如 demo/v1.0/dwg/CTRL-DWG-01.svg
  manual_code     TEXT NOT NULL,
  version_label   TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'drawing'
                    CHECK (kind IN ('drawing','photo')),
  content_type    TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,          -- 本地对象存储相对路径（可替换为 S3/MinIO）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 图纸修订血缘（升级/撤回分析用）
CREATE TABLE IF NOT EXISTS drawing_lineage (
  id              SERIAL PRIMARY KEY,
  manual_code     TEXT NOT NULL,
  drawing_key     TEXT NOT NULL,          -- 跨版本稳定的图纸键
  version_label   TEXT NOT NULL,
  object_key      TEXT NOT NULL REFERENCES objects(object_key),
  change_note     TEXT NOT NULL DEFAULT '',
  is_withdrawn    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (manual_code, drawing_key, version_label)
);

-- ============================================================================
-- 安装实例（PG 保存本实例所用版本 = manual_version_id 固定，不随手册升级漂移）
-- ============================================================================
CREATE TABLE IF NOT EXISTS instances (
  id                SERIAL PRIMARY KEY,
  instance_code     TEXT NOT NULL UNIQUE,       -- INST-xxxx
  name              TEXT NOT NULL,
  manual_version_id INTEGER NOT NULL REFERENCES manual_versions(id), -- 锁定版本
  model             TEXT,                        -- 已确认型号；NULL=待确认
  hw_revision       TEXT,                        -- 已确认硬件修订；NULL=待确认
  options           JSONB NOT NULL DEFAULT '{}',-- 其他确认项
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','blocked','completed','migrated')),
  -- 受控迁移
  migration_target_version INTEGER REFERENCES manual_versions(id),
  migration_status TEXT CHECK (migration_status IN
                      ('offered','acknowledged','reviewed','committed','canceled')),
  migrated_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 步骤执行状态（完成凭证绑定实际实例）
CREATE TABLE IF NOT EXISTS instance_steps (
  id              SERIAL PRIMARY KEY,
  instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  manual_version  INTEGER NOT NULL,          -- 勾选时所在版本（迁移后用于审计）
  step_key        TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','ready','in_progress','completed','skipped')),
  applicable      BOOLEAN NOT NULL DEFAULT TRUE, -- 条件求值结果
  completed_at    TIMESTAMPTZ,
  completed_by    TEXT,
  note            TEXT,
  UNIQUE (instance_id, manual_version, step_key)
);

-- 证据（照片等；允许离线迟到：captured_at 可早于 uploaded_at）
CREATE TABLE IF NOT EXISTS evidences (
  id              SERIAL PRIMARY KEY,
  instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  manual_version  INTEGER NOT NULL,
  object_key      TEXT REFERENCES objects(object_key), -- 迟到照片上传前可为空
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      INTEGER,
  sha256          TEXT,
  captured_at     TIMESTAMPTZ,             -- EXIF/填写的拍摄时间（可离线）
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  upload_state    TEXT NOT NULL DEFAULT 'stored'
                    CHECK (upload_state IN ('pending_offline','stored','quarantined')),
  bind_state      TEXT NOT NULL DEFAULT 'active'
                    CHECK (bind_state IN ('active','retained_legacy','superseded')),
  note            TEXT
);

-- 图纸升级产生的复核项（绝不是简单平移百分比）
CREATE TABLE IF NOT EXISTS review_items (
  id              SERIAL PRIMARY KEY,
  instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,          -- 受影响的（旧版本）已完成步骤
  old_version     INTEGER NOT NULL,
  new_version     INTEGER NOT NULL,
  reason          TEXT NOT NULL,          -- DRAWING_CHANGED / STEP_CHANGED / CONDITION_CHANGED ...
  detail          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','acknowledged','reverified','waived')),
  resolution_note TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 实例事件审计（重复勾选、打印失败、撤回、迁移差异确认等全部留痕）
CREATE TABLE IF NOT EXISTS instance_events (
  id              SERIAL PRIMARY KEY,
  instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  step_key        TEXT,
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 打印任务（失败可重试；导出/打印留痕）
CREATE TABLE IF NOT EXISTS print_jobs (
  id              SERIAL PRIMARY KEY,
  instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  job_type        TEXT NOT NULL DEFAULT 'manual_export',
  state           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','rendered','failed','done')),
  error_message   TEXT,
  artifact_key    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_steps_ver ON steps(manual_version);
CREATE INDEX IF NOT EXISTS idx_inst_steps ON instance_steps(instance_id);
CREATE INDEX IF NOT EXISTS idx_ev_inst ON evidences(instance_id);
CREATE INDEX IF NOT EXISTS idx_review_inst ON review_items(instance_id);
CREATE INDEX IF NOT EXISTS idx_events_inst ON instance_events(instance_id);
