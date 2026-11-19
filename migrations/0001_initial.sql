-- 1. Dynamic settings configurable from Telegram admin panel
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. News sources (soft-deleted via status = 'ARCHIVED'; never physically deleted)
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('rss', 'atom', 'gdelt')),
  publisher_group TEXT NOT NULL,
  is_wire_agency INTEGER NOT NULL DEFAULT 0,
  credibility_tier INTEGER NOT NULL CHECK (credibility_tier IN (1, 2, 3)),
  base_credibility INTEGER NOT NULL CHECK (base_credibility BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'ARCHIVED')),
  archived_at INTEGER,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at INTEGER NOT NULL DEFAULT 0,
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_sources_due ON sources (status, next_fetch_at);

-- 3. Story clusters (unit of scoring, AI analysis, and publishing)
CREATE TABLE story_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  primary_title TEXT NOT NULL,
  category TEXT NOT NULL,
  entities_json TEXT NOT NULL,
  locations_json TEXT NOT NULL,
  concepts_json TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  raw_article_count INTEGER NOT NULL DEFAULT 0,
  independent_source_count INTEGER NOT NULL DEFAULT 0,
  importance_score INTEGER NOT NULL DEFAULT 0,
  credibility_score INTEGER NOT NULL DEFAULT 0,
  confidence_score INTEGER NOT NULL DEFAULT 0,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
  verification_label TEXT NOT NULL CHECK (verification_label IN ('unverified', 'single_source', 'corroborated')),
  status TEXT NOT NULL DEFAULT 'COLLECTING' CHECK (status IN ('COLLECTING', 'QUEUED', 'PUBLISHED', 'DROPPED')),
  latest_revision INTEGER NOT NULL DEFAULT 0,
  last_published_at INTEGER,
  last_published_importance INTEGER,
  last_published_urgency TEXT,
  last_published_verification TEXT,
  last_published_concepts_json TEXT,
  ai_payload_json TEXT,
  ai_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_clusters_window ON story_clusters (status, event_time DESC);
CREATE INDEX idx_clusters_queue ON story_clusters (status, importance_score DESC, created_at ASC);

-- 4. Raw articles linked to clusters (historical integrity via ON DELETE RESTRICT)
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE RESTRICT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  url_hash TEXT NOT NULL UNIQUE,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  author TEXT,
  publisher_group TEXT NOT NULL,
  detected_wire_name TEXT,
  effective_origin_key TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_articles_cluster ON articles (cluster_id, fetched_at DESC);
CREATE INDEX idx_articles_cluster_origin ON articles (cluster_id, effective_origin_key);
CREATE INDEX idx_articles_source ON articles (source_id);

-- 5. Single Source of Truth for independent publishers per cluster
CREATE TABLE cluster_sources (
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE RESTRICT,
  effective_origin_key TEXT NOT NULL,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('publisher_group', 'wire_heuristic')),
  attribution_confidence TEXT NOT NULL CHECK (attribution_confidence IN ('high', 'medium', 'low')),
  detected_wire_name TEXT,
  first_source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  first_article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  article_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (cluster_id, effective_origin_key)
);

-- 6. Delivery Outbox (At-Most-Once state machine for Telegram publishing)
CREATE TABLE delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('INITIAL', 'UPDATE')),
  update_reason TEXT,
  channel_id TEXT NOT NULL,
  reply_to_message_id INTEGER,
  language TEXT NOT NULL CHECK (language IN ('fa', 'en')),
  has_ai_analysis INTEGER NOT NULL CHECK (has_ai_analysis IN (0, 1)),
  rendered_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  previous_attempt_token TEXT,
  sending_started_at INTEGER,
  sending_lease_expires_at INTEGER,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER,
  failure_code TEXT,
  failure_detail TEXT,
  last_manual_retry_by TEXT,
  last_manual_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_outbox_dispatch ON delivery_outbox (status, next_retry_at, created_at);
CREATE INDEX idx_outbox_stuck ON delivery_outbox (status, sending_lease_expires_at);

-- 7. Official publication history (distinguishes INITIAL vs UPDATE revisions)
CREATE TABLE publication_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE RESTRICT,
  outbox_id INTEGER NOT NULL UNIQUE REFERENCES delivery_outbox(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('INITIAL', 'UPDATE')),
  update_reason TEXT,
  channel_id TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  parent_telegram_message_id INTEGER,
  language TEXT NOT NULL CHECK (language IN ('fa', 'en')),
  has_ai_analysis INTEGER NOT NULL CHECK (has_ai_analysis IN (0, 1)),
  snapshot_importance INTEGER NOT NULL,
  snapshot_credibility INTEGER NOT NULL,
  snapshot_confidence INTEGER NOT NULL,
  snapshot_independent_sources INTEGER NOT NULL,
  snapshot_verification_label TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  UNIQUE (cluster_id, revision_number)
);
CREATE INDEX idx_pub_events_time ON publication_events (published_at DESC);

-- 8. Asynchronous job queue (replaces waitUntil for /runonce, feed tests, cleanup)
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('RUN_ONCE', 'TEST_FEEDS', 'CLEANUP')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  priority INTEGER NOT NULL DEFAULT 10,
  payload_json TEXT,
  requested_by_chat_id TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_jobs_claim ON jobs (status, lease_expires_at, priority, created_at);

-- 9. Atomic global leases with monotonic fencing token
CREATE TABLE leases (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 1,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 10. System logs and audit trail
CREATE TABLE system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR')),
  component TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_logs_time ON system_logs (created_at DESC);

-- 11. Telegram Webhook update deduplication (anti-replay)
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
CREATE INDEX idx_tg_updates_time ON telegram_updates (processed_at);