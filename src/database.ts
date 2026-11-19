import {
  DEFAULT_SETTINGS,
  LeaseLostError,
  type BotSettings,
  type ClusterSourceRecord,
  type CreateClusterInput,
  type EnqueueOutboxInput,
  type InsertArticleInput,
  type JobRecord,
  type JobType,
  type LeaseContext,
  type LeaseRecord,
  type LogLevel,
  type OutboxFailureCode,
  type OutboxRecord,
  type PublicationSnapshot,
  type SourceRecord,
  type StoryClusterRecord,
  type SystemLogRecord,
  type UpsertSourceInput,
} from "./types";

export const CRON_LOCK_NAME = "cron_pipeline";
export const DEFAULT_LEASE_TTL_MS = 90_000;
export const LEASE_RENEW_THRESHOLD_MS = 45_000;
export const OUTBOX_SENDING_LEASE_MS = 30_000;
export const OUTBOX_MIN_MAIN_LEASE_MARGIN_MS = 45_000;
export const CLEANUP_MAX_CLUSTERS_PER_RUN = 25;

// ============================================================================
// 1. Atomic Lease Lock with Monotonic Fencing Token
// ============================================================================

export async function acquireLease(
  db: D1Database,
  ownerId: string,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  lockName: string = CRON_LOCK_NAME
): Promise<LeaseContext | null> {
  const expiresAt = now + ttlMs;
  const row = await db
    .prepare(
      `INSERT INTO leases (lock_name, owner_id, fencing_token, acquired_at, expires_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(lock_name) DO UPDATE SET
         owner_id = excluded.owner_id,
         fencing_token = leases.fencing_token + 1,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
       WHERE leases.expires_at <= ?
       RETURNING lock_name, owner_id, fencing_token, acquired_at, expires_at`
    )
    .bind(lockName, ownerId, now, expiresAt, now)
    .first<LeaseRecord>();

  if (!row) {
    return null;
  }

  return {
    lockName: row.lock_name,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    expiresAt: row.expires_at,
  };
}

export async function renewLease(
  db: D1Database,
  lease: LeaseContext,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): Promise<LeaseContext> {
  const nextExpiresAt = now + ttlMs;
  const row = await db
    .prepare(
      `UPDATE leases
       SET expires_at = ?
       WHERE lock_name = ?
         AND owner_id = ?
         AND fencing_token = ?
         AND expires_at > ?
       RETURNING lock_name, owner_id, fencing_token, acquired_at, expires_at`
    )
    .bind(nextExpiresAt, lease.lockName, lease.ownerId, lease.fencingToken, now)
    .first<LeaseRecord>();

  if (!row) {
    throw new LeaseLostError(
      `Failed to renew lease ${lease.lockName} for owner ${lease.ownerId} (token=${lease.fencingToken})`
    );
  }

  return {
    lockName: row.lock_name,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    expiresAt: row.expires_at,
  };
}

export async function renewLeaseIfNeeded(
  db: D1Database,
  lease: LeaseContext,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): Promise<LeaseContext> {
  if (lease.expiresAt - now > LEASE_RENEW_THRESHOLD_MS) {
    return lease;
  }
  return renewLease(db, lease, now, ttlMs);
}

export async function releaseLease(
  db: D1Database,
  lease: LeaseContext,
  now: number = Date.now()
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE leases
       SET expires_at = 0
       WHERE lock_name = ?
         AND owner_id = ?
         AND fencing_token = ?
         AND expires_at > ?
       RETURNING lock_name`
    )
    .bind(lease.lockName, lease.ownerId, lease.fencingToken, now)
    .first<{ lock_name: string }>();

  return row !== null;
}

// ============================================================================
// 2. Dynamic Settings CRUD
// ============================================================================

export async function getSettings(db: D1Database): Promise<BotSettings> {
  const { results } = await db
    .prepare(`SELECT key, value_json FROM settings`)
    .all<{ key: string; value_json: string }>();

  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    if (row.key in DEFAULT_SETTINGS) {
      try {
        merged[row.key] = JSON.parse(row.value_json);
      } catch {
        // Ignore corrupted JSON and keep safe default
      }
    }
  }

  return merged as unknown as BotSettings;
}

export async function setSetting<K extends keyof BotSettings>(
  db: D1Database,
  key: K,
  value: BotSettings[K],
  now: number = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .bind(key, JSON.stringify(value), now)
    .run();
}

export async function seedDefaultSettings(
  db: D1Database,
  now: number = Date.now()
): Promise<void> {
  const entries = Object.entries(DEFAULT_SETTINGS) as [
    keyof BotSettings,
    BotSettings[keyof BotSettings],
  ][];
  const stmts = entries.map(([key, value]) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)`
      )
      .bind(key, JSON.stringify(value), now)
  );
  await db.batch(stmts);
}

// ============================================================================
// 3. Sources Management (Soft Delete Only)
// ============================================================================

export async function upsertSource(
  db: D1Database,
  input: UpsertSourceInput
): Promise<SourceRecord> {
  const row = await db
    .prepare(
      `INSERT INTO sources (
         name, url, type, publisher_group, is_wire_agency,
         credibility_tier, base_credibility, status, archived_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL)
       ON CONFLICT(url) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         publisher_group = excluded.publisher_group,
         is_wire_agency = excluded.is_wire_agency,
         credibility_tier = excluded.credibility_tier,
         base_credibility = excluded.base_credibility,
         status = 'ACTIVE',
         archived_at = NULL,
         consecutive_failures = 0,
         last_error = NULL
       RETURNING *`
    )
    .bind(
      input.name,
      input.url,
      input.type,
      input.publisherGroup,
      input.isWireAgency ? 1 : 0,
      input.credibilityTier,
      input.baseCredibility
    )
    .first<SourceRecord>();

  if (!row) {
    throw new Error(`Failed to upsert source: ${input.url}`);
  }
  return row;
}

export async function archiveSourceByUrl(
  db: D1Database,
  url: string,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sources
       SET status = 'ARCHIVED', archived_at = ?
       WHERE url = ? AND status != 'ARCHIVED'`
    )
    .bind(now, url)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listActiveSources(db: D1Database): Promise<SourceRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sources WHERE status = 'ACTIVE' ORDER BY id ASC`)
    .all<SourceRecord>();
  return results;
}

export async function getDueSources(
  db: D1Database,
  limit: number,
  now: number = Date.now()
): Promise<SourceRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sources
       WHERE status = 'ACTIVE' AND type IN ('rss', 'atom') AND next_fetch_at <= ?
       ORDER BY next_fetch_at ASC, id ASC
       LIMIT ?`
    )
    .bind(now, limit)
    .all<SourceRecord>();
  return results;
}

// ============================================================================
// 4. Story Clusters, Articles & Atomic SSOT Independent Source Sync
// ============================================================================

export async function createStoryCluster(
  db: D1Database,
  lease: LeaseContext,
  input: CreateClusterInput,
  now: number = Date.now()
): Promise<StoryClusterRecord> {
  const row = await db
    .prepare(
      `INSERT INTO story_clusters (
         primary_title, category, entities_json, locations_json, concepts_json,
         event_time, raw_article_count, independent_source_count,
         importance_score, credibility_score, confidence_score,
         urgency, verification_label, status, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM leases
         WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
       )
       RETURNING *`
    )
    .bind(
      input.primaryTitle,
      input.category,
      JSON.stringify(input.entities),
      JSON.stringify(input.locations),
      JSON.stringify(input.concepts),
      input.eventTime,
      input.importanceScore,
      input.credibilityScore,
      input.confidenceScore,
      input.urgency,
      input.verificationLabel,
      input.status ?? "COLLECTING",
      now,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    )
    .first<StoryClusterRecord>();

  if (!row) {
    throw new LeaseLostError("Cannot create story cluster without valid lease");
  }
  return row;
}

export async function insertArticleAndSyncCluster(
  db: D1Database,
  lease: LeaseContext,
  input: InsertArticleInput,
  now: number = Date.now()
): Promise<{ inserted: boolean }> {
  const stmtInsertArticle = db
    .prepare(
      `INSERT OR IGNORE INTO articles (
         cluster_id, source_id, url_hash, canonical_url, title, summary, author,
         publisher_group, detected_wire_name, effective_origin_key, published_at, fetched_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM leases
         WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
       )`
    )
    .bind(
      input.clusterId,
      input.sourceId,
      input.urlHash,
      input.canonicalUrl,
      input.title,
      input.summary,
      input.author,
      input.publisherGroup,
      input.detectedWireName,
      input.effectiveOriginKey,
      input.publishedAt,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    );

  const stmtSyncClusterSources = db
    .prepare(
      `INSERT INTO cluster_sources (
         cluster_id, effective_origin_key, origin_type, attribution_confidence,
         detected_wire_name, first_source_id, first_article_id, article_count, created_at
       )
       SELECT
         a.cluster_id,
         a.effective_origin_key,
         ?,
         ?,
         a.detected_wire_name,
         a.source_id,
         a.id,
         (
           SELECT COUNT(*) FROM articles a2
           WHERE a2.cluster_id = a.cluster_id
             AND a2.effective_origin_key = a.effective_origin_key
         ),
         ?
       FROM articles a
       WHERE a.url_hash = ?
         AND a.cluster_id = ?
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )
       ON CONFLICT(cluster_id, effective_origin_key) DO UPDATE SET
         article_count = (
           SELECT COUNT(*) FROM articles a2
           WHERE a2.cluster_id = excluded.cluster_id
             AND a2.effective_origin_key = excluded.effective_origin_key
         )`
    )
    .bind(
      input.originType,
      input.attributionConfidence,
      now,
      input.urlHash,
      input.clusterId,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    );

  const stmtSyncClusterCounters = db
    .prepare(
      `UPDATE story_clusters
       SET
         raw_article_count = (SELECT COUNT(*) FROM articles WHERE cluster_id = ?),
         independent_source_count = (SELECT COUNT(*) FROM cluster_sources WHERE cluster_id = ?),
         updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )`
    )
    .bind(
      input.clusterId,
      input.clusterId,
      now,
      input.clusterId,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    );

  const results = await db.batch([
    stmtInsertArticle,
    stmtSyncClusterSources,
    stmtSyncClusterCounters,
  ]);

  const clusterUpdated = (results[2]?.meta.changes ?? 0) > 0;
  if (!clusterUpdated) {
    throw new LeaseLostError(
      `Lease lost or cluster ${input.clusterId} missing during article sync`
    );
  }

  return {
    inserted: (results[0]?.meta.changes ?? 0) > 0,
  };
}

export async function getClusterById(
  db: D1Database,
  clusterId: number
): Promise<StoryClusterRecord | null> {
  return db
    .prepare(`SELECT * FROM story_clusters WHERE id = ?`)
    .bind(clusterId)
    .first<StoryClusterRecord>();
}

export async function getClusterSources(
  db: D1Database,
  clusterId: number
): Promise<ClusterSourceRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM cluster_sources WHERE cluster_id = ? ORDER BY created_at ASC`)
    .bind(clusterId)
    .all<ClusterSourceRecord>();
  return results;
}

// ============================================================================
// 5. Delivery Outbox State Machine & Publication Events
// ============================================================================

export async function enqueueOutboxDelivery(
  db: D1Database,
  lease: LeaseContext,
  input: EnqueueOutboxInput,
  now: number = Date.now()
): Promise<OutboxRecord | null> {
  const dedupKey = `${input.clusterId}:${input.revisionNumber}:${input.channelId}`;
  const row = await db
    .prepare(
      `INSERT OR IGNORE INTO delivery_outbox (
         dedup_key, cluster_id, revision_number, event_type, update_reason,
         channel_id, reply_to_message_id, language, has_ai_analysis,
         rendered_html, status, next_retry_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM leases
         WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
       )
       RETURNING *`
    )
    .bind(
      dedupKey,
      input.clusterId,
      input.revisionNumber,
      input.eventType,
      input.updateReason,
      input.channelId,
      input.replyToMessageId,
      input.language,
      input.hasAiAnalysis ? 1 : 0,
      input.renderedHtml,
      now,
      now,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    )
    .first<OutboxRecord>();

  return row;
}

export async function claimOutboxForSending(
  db: D1Database,
  lease: LeaseContext,
  outboxId: number,
  attemptToken: string,
  now: number = Date.now()
): Promise<OutboxRecord | null> {
  const sendingLeaseExpiresAt = now + OUTBOX_SENDING_LEASE_MS;
  const minMainLeaseExpiresAt = now + OUTBOX_MIN_MAIN_LEASE_MARGIN_MS;

  return db
    .prepare(
      `UPDATE delivery_outbox
       SET
         status = 'SENDING',
         attempt_count = attempt_count + 1,
         attempt_token = ?,
         sending_started_at = ?,
         sending_lease_expires_at = ?,
         updated_at = ?
       WHERE id = ?
         AND status = 'PENDING'
         AND next_retry_at <= ?
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )
       RETURNING *`
    )
    .bind(
      attemptToken,
      now,
      sendingLeaseExpiresAt,
      now,
      outboxId,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      minMainLeaseExpiresAt
    )
    .first<OutboxRecord>();
}

export async function markOutboxSentAndRecordPublication(
  db: D1Database,
  params: {
    outboxId: number;
    attemptToken: string;
    telegramMessageId: number;
    snapshot: PublicationSnapshot;
  },
  now: number = Date.now()
): Promise<boolean> {
  const stmtMarkSent = db
    .prepare(
      `UPDATE delivery_outbox
       SET
         status = 'SENT',
         telegram_message_id = ?,
         failure_code = NULL,
         failure_detail = NULL,
         sent_at = ?,
         updated_at = ?
       WHERE id = ?
         AND status = 'SENDING'
         AND attempt_token = ?`
    )
    .bind(
      params.telegramMessageId,
      now,
      now,
      params.outboxId,
      params.attemptToken
    );

  const stmtInsertPubEvent = db
    .prepare(
      `INSERT OR IGNORE INTO publication_events (
         cluster_id, outbox_id, revision_number, event_type, update_reason,
         channel_id, telegram_message_id, parent_telegram_message_id,
         language, has_ai_analysis,
         snapshot_importance, snapshot_credibility, snapshot_confidence,
         snapshot_independent_sources, snapshot_verification_label, published_at
       )
       SELECT
         o.cluster_id,
         o.id,
         o.revision_number,
         o.event_type,
         o.update_reason,
         o.channel_id,
         o.telegram_message_id,
         o.reply_to_message_id,
         o.language,
         o.has_ai_analysis,
         ?, ?, ?, ?, ?, ?
       FROM delivery_outbox o
       WHERE o.id = ? AND o.status = 'SENT' AND o.attempt_token = ?`
    )
    .bind(
      params.snapshot.importance,
      params.snapshot.credibility,
      params.snapshot.confidence,
      params.snapshot.independentSources,
      params.snapshot.verificationLabel,
      now,
      params.outboxId,
      params.attemptToken
    );

  const stmtUpdateCluster = db
    .prepare(
      `UPDATE story_clusters
       SET
         status = 'PUBLISHED',
         latest_revision = (SELECT revision_number FROM delivery_outbox WHERE id = ?),
         last_published_at = ?,
         last_published_importance = ?,
         last_published_urgency = ?,
         last_published_verification = ?,
         last_published_concepts_json = ?,
         updated_at = ?
       WHERE id = (SELECT cluster_id FROM delivery_outbox WHERE id = ?)
         AND EXISTS (SELECT 1 FROM publication_events WHERE outbox_id = ?)`
    )
    .bind(
      params.outboxId,
      now,
      params.snapshot.importance,
      params.snapshot.urgency,
      params.snapshot.verificationLabel,
      params.snapshot.conceptsJson,
      now,
      params.outboxId,
      params.outboxId
    );

  const results = await db.batch([
    stmtMarkSent,
    stmtInsertPubEvent,
    stmtUpdateCluster,
  ]);

  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function markOutboxRetryable(
  db: D1Database,
  outboxId: number,
  attemptToken: string,
  nextRetryAt: number,
  failureDetail: string,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE delivery_outbox
       SET
         status = 'PENDING',
         next_retry_at = ?,
         failure_code = 'RATE_LIMITED',
         failure_detail = ?,
         updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND attempt_token = ?`
    )
    .bind(nextRetryAt, failureDetail, now, outboxId, attemptToken)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function markOutboxFailed(
  db: D1Database,
  outboxId: number,
  attemptToken: string,
  failureCode: Exclude<OutboxFailureCode, "RATE_LIMITED">,
  failureDetail: string,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE delivery_outbox
       SET
         status = 'FAILED',
         failure_code = ?,
         failure_detail = ?,
         updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND attempt_token = ?`
    )
    .bind(failureCode, failureDetail, now, outboxId, attemptToken)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function failStuckSendingOutbox(
  db: D1Database,
  lease: LeaseContext,
  now: number = Date.now()
): Promise<OutboxRecord[]> {
  const { results } = await db
    .prepare(
      `UPDATE delivery_outbox
       SET
         status = 'FAILED',
         failure_code = 'AMBIGUOUS_DELIVERY_STATE',
         failure_detail = 'Worker crashed or timed out while sending to Telegram',
         updated_at = ?
       WHERE status = 'SENDING'
         AND sending_lease_expires_at <= ?
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )
       RETURNING *`
    )
    .bind(
      now,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    )
    .all<OutboxRecord>();

  return results;
}

export async function manualRetryOutbox(
  db: D1Database,
  outboxId: number,
  adminUserId: string,
  now: number = Date.now()
): Promise<boolean> {
  const existing = await db
    .prepare(`SELECT * FROM delivery_outbox WHERE id = ? AND status = 'FAILED'`)
    .bind(outboxId)
    .first<OutboxRecord>();

  if (!existing) {
    return false;
  }

  const auditMeta = JSON.stringify({
    outboxId: existing.id,
    clusterId: existing.cluster_id,
    revisionNumber: existing.revision_number,
    previousAttemptToken: existing.attempt_token,
    previousAttemptCount: existing.attempt_count,
    previousFailureCode: existing.failure_code,
    adminUserId,
  });

  const stmtRequeue = db
    .prepare(
      `UPDATE delivery_outbox
       SET
         status = 'PENDING',
         previous_attempt_token = attempt_token,
         attempt_token = NULL,
         sending_started_at = NULL,
         sending_lease_expires_at = NULL,
         next_retry_at = ?,
         last_manual_retry_by = ?,
         last_manual_retry_at = ?,
         updated_at = ?
       WHERE id = ? AND status = 'FAILED'`
    )
    .bind(now, adminUserId, now, now, outboxId);

  const stmtAuditLog = db
    .prepare(
      `INSERT INTO system_logs (level, component, message, meta_json, created_at)
       SELECT 'WARN', 'outbox_manual_retry', ?, ?, ?
       FROM delivery_outbox
       WHERE id = ?
         AND status = 'PENDING'
         AND last_manual_retry_by = ?
         AND last_manual_retry_at = ?`
    )
    .bind(
      `Manual retry requested for outbox #${outboxId} by admin ${adminUserId}`,
      auditMeta,
      now,
      outboxId,
      adminUserId,
      now
    );

  const results = await db.batch([stmtRequeue, stmtAuditLog]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

// ============================================================================
// 6. Asynchronous Job Queue
// ============================================================================

export async function enqueueJob(
  db: D1Database,
  params: {
    type: JobType;
    priority?: number;
    payload?: Record<string, unknown>;
    requestedByChatId?: string;
    maxAttempts?: number;
  },
  now: number = Date.now()
): Promise<JobRecord> {
  const row = await db
    .prepare(
      `INSERT INTO jobs (
         type, status, priority, payload_json, requested_by_chat_id,
         max_attempts, created_at, updated_at
       )
       VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.type,
      params.priority ?? 10,
      params.payload ? JSON.stringify(params.payload) : null,
      params.requestedByChatId ?? null,
      params.maxAttempts ?? 3,
      now,
      now
    )
    .first<JobRecord>();

  if (!row) {
    throw new Error(`Failed to enqueue job ${params.type}`);
  }
  return row;
}

export async function failExhaustedJobs(
  db: D1Database,
  lease: LeaseContext,
  now: number = Date.now()
): Promise<JobRecord[]> {
  const { results } = await db
    .prepare(
      `UPDATE jobs
       SET
         status = 'FAILED',
         result_summary = 'Job exceeded max attempts after lease expiration',
         updated_at = ?,
         completed_at = ?
       WHERE status = 'RUNNING'
         AND lease_expires_at <= ?
         AND attempt_count >= max_attempts
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )
       RETURNING *`
    )
    .bind(
      now,
      now,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    )
    .all<JobRecord>();

  return results;
}

export async function claimNextJob(
  db: D1Database,
  lease: LeaseContext,
  jobLeaseTtlMs: number = DEFAULT_LEASE_TTL_MS,
  now: number = Date.now()
): Promise<JobRecord | null> {
  const jobExpiresAt = now + jobLeaseTtlMs;
  return db
    .prepare(
      `UPDATE jobs
       SET
         status = 'RUNNING',
         lease_owner = ?,
         lease_expires_at = ?,
         attempt_count = attempt_count + 1,
         updated_at = ?
       WHERE id = (
         SELECT id FROM jobs
         WHERE (
           status = 'PENDING'
           OR (status = 'RUNNING' AND lease_expires_at <= ?)
         )
           AND attempt_count < max_attempts
         ORDER BY priority ASC, created_at ASC
         LIMIT 1
       )
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )
       RETURNING *`
    )
    .bind(
      lease.ownerId,
      jobExpiresAt,
      now,
      now,
      lease.lockName,
      lease.ownerId,
      lease.fencingToken,
      now
    )
    .first<JobRecord>();
}

export async function completeJob(
  db: D1Database,
  jobId: number,
  ownerId: string,
  status: "COMPLETED" | "FAILED",
  resultSummary: string,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs
       SET
         status = ?,
         result_summary = ?,
         updated_at = ?,
         completed_at = ?
       WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`
    )
    .bind(status, resultSummary, now, now, jobId, ownerId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

// ============================================================================
// 7. Safe Atomic Cleanup (cluster_sources -> articles -> story_clusters)
// ============================================================================

export async function cleanupUnpublishedClusters(
  db: D1Database,
  lease: LeaseContext,
  olderThanTimestamp: number,
  now: number = Date.now(),
  maxBatchSize: number = CLEANUP_MAX_CLUSTERS_PER_RUN
): Promise<number> {
  const cappedLimit = Math.min(Math.max(1, maxBatchSize), CLEANUP_MAX_CLUSTERS_PER_RUN);
  const { results: candidateRows } = await db
    .prepare(
      `SELECT sc.id
       FROM story_clusters sc
       WHERE sc.status IN ('DROPPED', 'COLLECTING')
         AND sc.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM publication_events pe WHERE pe.cluster_id = sc.id)
         AND NOT EXISTS (SELECT 1 FROM delivery_outbox do WHERE do.cluster_id = sc.id)
       ORDER BY sc.created_at ASC
       LIMIT ?`
    )
    .bind(olderThanTimestamp, cappedLimit)
    .all<{ id: number }>();

  const ids = candidateRows.map((row) => row.id);
  if (ids.length === 0) {
    return 0;
  }

  const placeholders = ids.map(() => "?").join(", ");
  const leaseParams = [lease.lockName, lease.ownerId, lease.fencingToken, now];

  const stmtDeleteClusterSources = db
    .prepare(
      `DELETE FROM cluster_sources
       WHERE cluster_id IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM publication_events pe WHERE pe.cluster_id = cluster_sources.cluster_id)
         AND NOT EXISTS (SELECT 1 FROM delivery_outbox do WHERE do.cluster_id = cluster_sources.cluster_id)
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )`
    )
    .bind(...ids, ...leaseParams);

  const stmtDeleteArticles = db
    .prepare(
      `DELETE FROM articles
       WHERE cluster_id IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM cluster_sources cs WHERE cs.cluster_id = articles.cluster_id)
         AND NOT EXISTS (SELECT 1 FROM publication_events pe WHERE pe.cluster_id = articles.cluster_id)
         AND NOT EXISTS (SELECT 1 FROM delivery_outbox do WHERE do.cluster_id = articles.cluster_id)
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )`
    )
    .bind(...ids, ...leaseParams);

  const stmtDeleteClusters = db
    .prepare(
      `DELETE FROM story_clusters
       WHERE id IN (${placeholders})
         AND status IN ('DROPPED', 'COLLECTING')
         AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.cluster_id = story_clusters.id)
         AND NOT EXISTS (SELECT 1 FROM cluster_sources cs WHERE cs.cluster_id = story_clusters.id)
         AND NOT EXISTS (SELECT 1 FROM publication_events pe WHERE pe.cluster_id = story_clusters.id)
         AND NOT EXISTS (SELECT 1 FROM delivery_outbox do WHERE do.cluster_id = story_clusters.id)
         AND EXISTS (
           SELECT 1 FROM leases
           WHERE lock_name = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
         )`
    )
    .bind(...ids, ...leaseParams);

  const results = await db.batch([
    stmtDeleteClusterSources,
    stmtDeleteArticles,
    stmtDeleteClusters,
  ]);

  return results[2]?.meta.changes ?? 0;
}

// ============================================================================
// 8. System Logs & Telegram Update Anti-Replay
// ============================================================================

export async function logSystemEvent(
  db: D1Database,
  level: LogLevel,
  component: string,
  message: string,
  meta?: Record<string, unknown>,
  now: number = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_logs (level, component, message, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(level, component, message, meta ? JSON.stringify(meta) : null, now)
    .run();
}

export async function getRecentLogs(
  db: D1Database,
  limit: number = 20
): Promise<SystemLogRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM system_logs ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all<SystemLogRecord>();
  return results;
}

export async function recordTelegramUpdateIfNew(
  db: D1Database,
  updateId: number,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO telegram_updates (update_id, processed_at)
       VALUES (?, ?)`
    )
    .bind(updateId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ============================================================================
// 9. Admin Panel & Status Queries
// ============================================================================

export async function archiveSourceById(
  db: D1Database,
  sourceId: number,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sources
       SET status = 'ARCHIVED', archived_at = ?
       WHERE id = ? AND status != 'ARCHIVED'`
    )
    .bind(now, sourceId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listFailedOutbox(
  db: D1Database,
  limit: number = 5
): Promise<OutboxRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM delivery_outbox
       WHERE status = 'FAILED'
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<OutboxRecord>();
  return results;
}

export interface SystemStatusSummary {
  activeSources: number;
  queuedClusters: number;
  publishedTotal: number;
  publishedLastHour: number;
  publishedLast24Hours: number;
  pendingJobs: number;
  failedOutboxCount: number;
  recentErrorCount: number;
}

export async function getSystemStatusSummary(
  db: D1Database,
  now: number = Date.now()
): Promise<SystemStatusSummary> {
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const [
    sourcesRes,
    queuedRes,
    pubTotalRes,
    pubHourRes,
    pubDayRes,
    jobsRes,
    failedOutboxRes,
    errorsRes,
  ] = await db.batch<{ count: number }>([
    db.prepare(`SELECT COUNT(*) AS count FROM sources WHERE status = 'ACTIVE'`),
    db.prepare(`SELECT COUNT(*) AS count FROM story_clusters WHERE status = 'QUEUED'`),
    db.prepare(`SELECT COUNT(*) AS count FROM publication_events`),
    db
      .prepare(`SELECT COUNT(*) AS count FROM publication_events WHERE published_at >= ?`)
      .bind(oneHourAgo),
    db
      .prepare(`SELECT COUNT(*) AS count FROM publication_events WHERE published_at >= ?`)
      .bind(oneDayAgo),
    db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('PENDING', 'RUNNING')`),
    db.prepare(`SELECT COUNT(*) AS count FROM delivery_outbox WHERE status = 'FAILED'`),
    db
      .prepare(`SELECT COUNT(*) AS count FROM system_logs WHERE level = 'ERROR' AND created_at >= ?`)
      .bind(oneDayAgo),
  ]);

  return {
    activeSources: Number(sourcesRes?.results[0]?.count ?? 0),
    queuedClusters: Number(queuedRes?.results[0]?.count ?? 0),
    publishedTotal: Number(pubTotalRes?.results[0]?.count ?? 0),
    publishedLastHour: Number(pubHourRes?.results[0]?.count ?? 0),
    publishedLast24Hours: Number(pubDayRes?.results[0]?.count ?? 0),
    pendingJobs: Number(jobsRes?.results[0]?.count ?? 0),
    failedOutboxCount: Number(failedOutboxRes?.results[0]?.count ?? 0),
    recentErrorCount: Number(errorsRes?.results[0]?.count ?? 0),
  };
}