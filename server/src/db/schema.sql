-- ============================================================================
-- 硬件安装手册系统 schema（PostgreSQL；本地 PGlite / 生产 pg 同一套 SQL）
-- 设计要点：
--   * 型号 + 硬件修订(HW revision) 共同决定适用手册分支
--   * 手册内容按 manual_version 整体版本化；实例创建时钉住版本(lock)
--   * 步骤依赖为版本内 DAG（step_dep 只引用同版本步骤）
--   * 完成凭证(evidence)绑定具体 instance_step（实例 × 步骤），不可重绑
--   * 图纸 drawing 多版本，撤回(withdraw)只阻断新引用、不删除旧证据
-- ============================================================================

CREATE TABLE IF NOT EXISTS model (
  id          TEXT PRIMARY KEY,
  family      TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,          -- 如 AX-210
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued'))
);

CREATE TABLE IF NOT EXISTS hardware_revision (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES model(id),
  rev         TEXT NOT NULL,                  -- A / B
  released_on DATE,
  note        TEXT NOT NULL DEFAULT '',
  UNIQUE (model_id, rev)
);

-- 分支判定条件定义（由后端管理；条件回答前不允许自行猜选相近型号）
CREATE TABLE IF NOT EXISTS condition_def (
  id           TEXT PRIMARY KEY,
  scope_model  TEXT REFERENCES model(id),     -- NULL = 通用条件
  key          TEXT NOT NULL,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('choice','text','boolean')),
  options_json TEXT NOT NULL DEFAULT '[]',    -- [{value,label}]
  required     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (scope_model, key)
);

CREATE TABLE IF NOT EXISTS manual (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES model(id),
  hw_rev      TEXT NOT NULL,                  -- 硬件修订，决定分支
  title       TEXT NOT NULL,
  UNIQUE (model_id, hw_rev)
);

-- 手册版本（受控发布）。branch 可用于细分，但此处主分支由型号+HW修订决定
CREATE TABLE IF NOT EXISTS manual_version (
  id           TEXT PRIMARY KEY,
  manual_id    TEXT NOT NULL REFERENCES manual(id),
  version      TEXT NOT NULL,                 -- 1.0.0 / 1.1.0
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','published','retired')),
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_note  TEXT NOT NULL DEFAULT '',
  UNIQUE (manual_id, version)
);

CREATE TABLE IF NOT EXISTS step (
  id              TEXT PRIMARY KEY,
  version_id      TEXT NOT NULL REFERENCES manual_version(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,             -- 版本内稳定步骤码，用于跨版比对
  seq             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,             -- 仅来自给定演示资料的原文/占位
  applicability   TEXT DEFAULT 'true',       -- 安全表达式，引用条件变量
  required_evidence TEXT NOT NULL DEFAULT 'none'
                    CHECK (required_evidence IN ('none','photo','value','photo_or_value','photo_and_value')),
  evidence_label  TEXT NOT NULL DEFAULT '',  -- 要求凭证的说明（不含编造数值）
  value_unit      TEXT,
  -- 数值凭证规则（仅来自给定资料；{min,max} 为资料给出的允许区间，缺省则只记录不判定）
  evidence_rule   TEXT,
  UNIQUE (version_id, code)
);

-- 版本内 DAG：from_step 完成后 to_step 才可执行（两步骤必须属于同一版本）
CREATE TABLE IF NOT EXISTS step_dep (
  version_id  TEXT NOT NULL REFERENCES manual_version(id) ON DELETE CASCADE,
  from_step   TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  to_step     TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  PRIMARY KEY (from_step, to_step),
  CHECK (from_step <> to_step)
);

-- 警示紧邻其适用步骤；condition_expr 缺省 true = 恒显示
CREATE TABLE IF NOT EXISTS step_warning (
  id             TEXT PRIMARY KEY,
  step_id        TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  severity       TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('caution','warning','danger')),
  message        TEXT NOT NULL,
  condition_expr TEXT
);

-- 图纸（对象库存图）：多版本；current 版本指针由 published 标记
CREATE TABLE IF NOT EXISTS drawing (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- 如 DWG-RACK-A
  title       TEXT NOT NULL,
  model_id    TEXT REFERENCES model(id)
);

CREATE TABLE IF NOT EXISTS drawing_version (
  id           TEXT PRIMARY KEY,
  drawing_id   TEXT NOT NULL REFERENCES drawing(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  object_key   TEXT NOT NULL,                -- 对象存储 key
  content_sha  TEXT NOT NULL,
  media_type   TEXT NOT NULL DEFAULT 'image/svg+xml',
  status       TEXT NOT NULL DEFAULT 'published'
                 CHECK (status IN ('published','superseded','withdrawn')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_note  TEXT NOT NULL DEFAULT '',
  UNIQUE (drawing_id, version)
);

-- 步骤引用某图纸的某“主版本族”；实例执行时钉住具体 drawing_version
CREATE TABLE IF NOT EXISTS step_drawing (
  step_id           TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  drawing_id        TEXT NOT NULL REFERENCES drawing(id),
  -- 手册版本钉住的具体图纸版本（锁旧手册时实例始终看这一版）
  drawing_version_id TEXT REFERENCES drawing_version(id),
  PRIMARY KEY (step_id, drawing_id)
);

-- ============================================================================
-- 安装实例
-- ============================================================================
CREATE TABLE IF NOT EXISTS instance (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  model_id         TEXT NOT NULL REFERENCES model(id),
  hw_rev           TEXT NOT NULL,
  -- 实例创建时“钉住”的资料版本；迁移前永远显示该版，不被新版自动覆盖
  version_id       TEXT NOT NULL REFERENCES manual_version(id),
  status           TEXT NOT NULL DEFAULT 'collecting'
                     CHECK (status IN ('collecting','ready','in_progress','blocked','complete','finalized')),
  migration_policy TEXT NOT NULL DEFAULT 'lock'
                     CHECK (migration_policy IN ('lock','controlled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at     TIMESTAMPTZ
);

-- 实例对条件问题的回答（含 NULL/未答）；未知条件 => 停在待确认
CREATE TABLE IF NOT EXISTS instance_condition (
  instance_id  TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  condition_id TEXT NOT NULL REFERENCES condition_def(id),
  value        TEXT,
  answered_at  TIMESTAMPTZ,
  PRIMARY KEY (instance_id, condition_id)
);

-- 实例步骤执行行：完成凭证绑定此行（不可跨实例/跨步骤复用）
CREATE TABLE IF NOT EXISTS instance_step (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL REFERENCES step(id),
  step_code    TEXT NOT NULL,               -- 冗余保存，迁移后仍可追溯
  state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','in_progress','done','recheck_open','recheck_resolved','not_applicable','superseded')),
  done_at      TIMESTAMPTZ,
  done_by      TEXT,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  -- 执行时钉住的图纸内容哈希：图纸撤回/升级可据此发现“旧图执行”
  drawing_sha  TEXT,
  UNIQUE (instance_id, step_id)
);

CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  instance_step_id TEXT NOT NULL REFERENCES instance_step(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('photo','value','note')),
  object_key   TEXT,                          -- photo: 对象存储 key
  content_sha  TEXT,                          -- 对象内容 sha256（迟到照片同此校验）
  value_text   TEXT,                          -- value/note: 现场实测/记录文本
  captured_at  TIMESTAMPTZ,                   -- 现场拍摄时间（可能早于上传）
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by  TEXT NOT NULL DEFAULT 'installer',
  late         BOOLEAN NOT NULL DEFAULT FALSE, -- 离线迟到照片标记
  superseded   BOOLEAN NOT NULL DEFAULT FALSE  -- 迁移后被新证据替代；旧证据保留不删
);

-- 复核项：图纸升级/撤回影响已执行步骤、或迁移差异需要复核
CREATE TABLE IF NOT EXISTS review_item (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  instance_step_id TEXT REFERENCES instance_step(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL CHECK (reason IN ('drawing_upgraded','drawing_withdrawn','migration_diff','branch_switch_diff')),
  detail       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT
);

-- 受控迁移记录：差异必须逐项确认；旧证据保留
CREATE TABLE IF NOT EXISTS migration (
  id              TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  from_version_id TEXT NOT NULL REFERENCES manual_version(id),
  to_version_id   TEXT NOT NULL REFERENCES manual_version(id),
  diff_json       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','confirmed','rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ,
  confirmed_by    TEXT
);

-- 失败可重试的打印任务（打印失败不得让步骤静默“未发生”）
CREATE TABLE IF NOT EXISTS print_job (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- checklist / export
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','printed','failed')),
  error       TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 审计事件（分支切换、勾选、撤回、迁移确认等）
CREATE TABLE IF NOT EXISTS event_log (
  id          BIGSERIAL PRIMARY KEY,
  instance_id TEXT REFERENCES instance(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL DEFAULT 'installer',
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
