import {
  analyzeClusterWithGemini,
  checkGeminiQuotaAndCooldown,
  recordGeminiUsage,
  setGeminiCooldown,
  type GeminiAnalysisOutput,
  type GeminiFetchLike,
} from "./ai/gemini";
import {
  acquireLease,
  claimNextJob,
  claimOutboxForSending,
  cleanupOldOperationalRecords,
  cleanupUnpublishedClusters,
  completeJob,
  createStoryCluster,
  enqueueOutboxDelivery,
  failExhaustedJobs,
  failStuckSendingOutbox,
  findExistingUrlHashes,
  getActiveClustersForMatching,
  getClusterArticlesWithSources,
  getClusterById,
  getClusterIndependentSourceSignals,
  getClusterPublicationEvents,
  getDueSources,
  getOrCreateGdeltSource,
  getPublishedCounts,
  getQueuedClustersForPublishing,
  getRuntimeNumber,
  getSettings,
  insertArticleAndSyncCluster,
  listActiveSources,
  listDispatchableOutbox,
  logSystemEvent,
  markOutboxFailed,
  markOutboxRetryable,
  markOutboxSentAndRecordPublication,
  releaseLease,
  renewLease,
  renewLeaseIfNeeded,
  saveClusterAiResult,
  seedDefaultSettings,
  seedDefaultSourcesIfEmpty,
  setRuntimeNumber,
  updateClusterEvaluation,
  updateSourceFetchOutcome,
  type ClusterArticleWithSource,
} from "./database";
import {
  canonicalizeUrl,
  CLUSTER_WINDOW_MS,
  computeUrlHash,
  detectOriginAttribution,
  extractStoryFeatures,
  findBestMatchingCluster,
  type ClusterCandidate,
} from "./dedup";
import type { Env } from "./env";
import { DEFAULT_NEWS_SOURCES } from "./feeds/default-sources";
import { fetchGdeltArticles } from "./feeds/gdelt";
import {
  fetchAndParseFeed,
  type FeedFetchLike,
  type RawFeedItem,
} from "./feeds/rss";
import { formatNewsPost } from "./formatter";
import {
  classifyArticleCategory,
  evaluatePublishGate,
  evaluateUpdateMateriality,
  scoreCluster,
} from "./scoring";
import { escapeHtml, parseAdminUserIds } from "./security";
import { TelegramClient, type FetchLike } from "./telegram";
import {
  LeaseLostError,
  type BotSettings,
  type JobRecord,
  type LeaseContext,
  type OutboxRecord,
  type PublicationEventType,
  type SourceRecord,
  type StoryClusterRecord,
} from "./types";

const RUNTIME_LAST_CHECK_KEY = "_runtime_last_cron_check_at";
const RUNTIME_LAST_GDELT_KEY = "_runtime_last_gdelt_fetch_at";
const RUNTIME_LAST_CLEANUP_KEY = "_runtime_last_cleanup_at";

const CRON_JITTER_TOLERANCE_MS = 30_000;
const GDELT_MIN_INTERVAL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UNPUBLISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GEMINI_CALLS_PER_TICK = 2;
const MAX_OUTBOX_DISPATCH_PER_TICK = 2;
const MAX_FEEDS_TO_TEST_IN_JOB = 4;

export interface PipelineDependencies {
  fetchFeed?: FeedFetchLike;
  fetchGdelt?: FeedFetchLike;
  fetchGemini?: GeminiFetchLike;
  fetchTelegram?: FetchLike;
  now?: () => number;
  ownerId?: string;
}

export interface PipelineRunSummary {
  skippedReason?: string;
  feedsChecked: number;
  articlesIngested: number;
  clustersCreated: number;
  clustersUpdated: number;
  geminiCalls: number;
  outboxEnqueued: number;
  postsSent: number;
  postsFailed: number;
  stuckOutboxRecovered: number;
  jobProcessed?: string;
}

interface PendingPublicationTask {
  clusterId: number;
  eventType: PublicationEventType;
  revisionNumber: number;
  updateReason: string | null;
  replyToMessageId: number | null;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function mergeUniqueStrings(
  existing: readonly string[],
  added: readonly string[],
  maxItems: number
): string[] {
  return [...new Set([...existing, ...added])].slice(0, maxItems);
}

function computeNextFetchTime(
  ok: boolean,
  previousFailures: number,
  checkIntervalMinutes: number,
  now: number
): number {
  const baseMs = Math.max(5, checkIntervalMinutes) * 60 * 1000;
  if (ok) {
    return now + baseMs;
  }
  const failures = previousFailures + 1;
  // Exponential backoff capped at 6 hours for failing feeds
  const backoffMinutes = Math.min(360, 10 * Math.pow(2, Math.min(failures - 1, 5)));
  return now + backoffMinutes * 60 * 1000;
}

export async function runScheduledPipeline(
  env: Env,
  deps?: PipelineDependencies
): Promise<PipelineRunSummary> {
  const nowFn = deps?.now ?? (() => Date.now());
  const ownerId = deps?.ownerId ?? crypto.randomUUID();
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, deps?.fetchTelegram);

  const summary: PipelineRunSummary = {
    feedsChecked: 0,
    articlesIngested: 0,
    clustersCreated: 0,
    clustersUpdated: 0,
    geminiCalls: 0,
    outboxEnqueued: 0,
    postsSent: 0,
    postsFailed: 0,
    stuckOutboxRecovered: 0,
  };

  await seedDefaultSettings(env.DB, nowFn());
  await seedDefaultSourcesIfEmpty(env.DB, DEFAULT_NEWS_SOURCES);

  let lease = await acquireLease(env.DB, ownerId, nowFn());
  if (!lease) {
    return { ...summary, skippedReason: "lease_held_by_another_worker" };
  }

  let activeRunOnceJob: JobRecord | null = null;

  try {
    const settings = await getSettings(env.DB);

    // ------------------------------------------------------------------------
    // Step 1: Recover stuck SENDING outbox items & alert admin (never auto-retry)
    // ------------------------------------------------------------------------
    lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
    const stuckOutbox = await failStuckSendingOutbox(env.DB, lease, nowFn());
    summary.stuckOutboxRecovered = stuckOutbox.length;
    for (const item of stuckOutbox) {
      await logSystemEvent(
        env.DB,
        "ERROR",
        "outbox",
        `Outbox #${item.id} timed out in SENDING state; marked FAILED (ambiguous)`,
        { outboxId: item.id, clusterId: item.cluster_id, attemptToken: item.attempt_token },
        nowFn()
      );
      await notifyAdminsAboutFailedOutbox(env, telegram, item, true);
    }

    // ------------------------------------------------------------------------
    // Step 2: Fail exhausted jobs (poison-pill guard) & claim next pending job
    // ------------------------------------------------------------------------
    lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
    const exhaustedJobs = await failExhaustedJobs(env.DB, lease, nowFn());
    for (const badJob of exhaustedJobs) {
      await logSystemEvent(
        env.DB,
        "ERROR",
        "jobs",
        `Job #${badJob.id} (${badJob.type}) failed after max attempts`,
        { jobId: badJob.id, type: badJob.type },
        nowFn()
      );
      if (badJob.requested_by_chat_id) {
        await telegram.sendMessage({
          chatId: badJob.requested_by_chat_id,
          text: `❌ Job شماره <code>#${badJob.id}</code> (<code>${escapeHtml(badJob.type)}</code>) پس از رسیدن به سقف تلاش‌ها متوقف شد.`,
        });
      }
    }

    const claimedJob = await claimNextJob(env.DB, lease, undefined, nowFn());
    if (claimedJob) {
      summary.jobProcessed = `${claimedJob.type}#${claimedJob.id}`;

      if (claimedJob.type === "TEST_FEEDS") {
        lease = await handleTestFeedsJob(env, lease, claimedJob, telegram, deps, nowFn);
        return summary;
      }

      if (claimedJob.type === "CLEANUP") {
        lease = await handleCleanupJob(env, lease, claimedJob, telegram, nowFn);
        return summary;
      }

      if (claimedJob.type === "RUN_ONCE") {
        activeRunOnceJob = claimedJob;
      }
    }

    // ------------------------------------------------------------------------
    // Step 3: Periodic daily cleanup (runs safely once every 24h)
    // ------------------------------------------------------------------------
    const lastCleanupAt = await getRuntimeNumber(env.DB, RUNTIME_LAST_CLEANUP_KEY);
    if (!activeRunOnceJob && nowFn() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
      const deletedClusters = await cleanupUnpublishedClusters(
        env.DB,
        lease,
        nowFn() - UNPUBLISHED_RETENTION_MS,
        nowFn()
      );
      const opCleanup = await cleanupOldOperationalRecords(env.DB, lease, nowFn());
      await setRuntimeNumber(env.DB, RUNTIME_LAST_CLEANUP_KEY, nowFn(), nowFn());
      await logSystemEvent(
        env.DB,
        "INFO",
        "cleanup",
        "Daily retention cleanup completed",
        { deletedClusters, ...opCleanup },
        nowFn()
      );
    }

    // ------------------------------------------------------------------------
    // Step 4: Respect Pause state
    // ------------------------------------------------------------------------
    if (settings.isPaused) {
      if (activeRunOnceJob) {
        const msg =
          "⏸ سیستم در حالت توقف (Pause) قرار دارد. برای اجرای بررسی، ابتدا دستور /resume را ارسال کنید.";
        await completeJob(env.DB, activeRunOnceJob.id, lease.ownerId, "COMPLETED", msg, nowFn());
        if (activeRunOnceJob.requested_by_chat_id) {
          await telegram.sendMessage({ chatId: activeRunOnceJob.requested_by_chat_id, text: msg });
        }
      }
      return { ...summary, skippedReason: "paused" };
    }

    // ------------------------------------------------------------------------
    // Step 5: Check interval gate & ingest due feeds (Conservative budget: <=2 feeds)
    // ------------------------------------------------------------------------
    const lastCheckAt = await getRuntimeNumber(env.DB, RUNTIME_LAST_CHECK_KEY);
    const intervalMs = settings.checkIntervalMinutes * 60 * 1000;
    const isIntervalDue =
      activeRunOnceJob !== null ||
      lastCheckAt === 0 ||
      nowFn() - lastCheckAt >= intervalMs - CRON_JITTER_TOLERANCE_MS;

    const updateCandidates: PendingPublicationTask[] = [];

    if (isIntervalDue) {
      await setRuntimeNumber(env.DB, RUNTIME_LAST_CHECK_KEY, nowFn(), nowFn());
      const ingestOutcome = await ingestAndClusterNews(
        env,
        lease,
        settings,
        deps,
        nowFn,
        activeRunOnceJob !== null
      );
      lease = ingestOutcome.lease;
      summary.feedsChecked = ingestOutcome.feedsChecked;
      summary.articlesIngested = ingestOutcome.articlesIngested;
      summary.clustersCreated = ingestOutcome.clustersCreated;
      summary.clustersUpdated = ingestOutcome.clustersUpdated;
      updateCandidates.push(...ingestOutcome.updateCandidates);
    } else {
      summary.skippedReason = "interval_not_due";
    }

    // ------------------------------------------------------------------------
    // Step 6: Analyze top eligible clusters (initial & updates) and enqueue Outbox
    // ------------------------------------------------------------------------
    if (settings.targetChannel) {
      const enqueueOutcome = await analyzeAndEnqueuePublications(
        env,
        lease,
        settings,
        updateCandidates,
        deps,
        nowFn
      );
      lease = enqueueOutcome.lease;
      summary.geminiCalls = enqueueOutcome.geminiCalls;
      summary.outboxEnqueued = enqueueOutcome.outboxEnqueued;
    }

    // ------------------------------------------------------------------------
    // Step 7: Dispatch pending Outbox items to Telegram (At-Most-Once)
    // ------------------------------------------------------------------------
    const dispatchOutcome = await dispatchPendingOutbox(
      env,
      lease,
      settings,
      telegram,
      nowFn
    );
    lease = dispatchOutcome.lease;
    summary.postsSent = dispatchOutcome.postsSent;
    summary.postsFailed = dispatchOutcome.postsFailed;

    // ------------------------------------------------------------------------
    // Step 8: Report RUN_ONCE completion to requesting admin
    // ------------------------------------------------------------------------
    if (activeRunOnceJob) {
      const reportText = [
        `✅ <b>گزارش اجرای فوری (Job #${activeRunOnceJob.id})</b>`,
        "",
        `• فیدهای بررسی‌شده: <b>${summary.feedsChecked}</b>`,
        `• مقالات جدید ثبت‌شده: <b>${summary.articlesIngested}</b>`,
        `• خوشه‌های جدید: <b>${summary.clustersCreated}</b> | به‌روزرسانی خوشه: <b>${summary.clustersUpdated}</b>`,
        `• درخواست Gemini: <b>${summary.geminiCalls}</b> | صف Outbox جدید: <b>${summary.outboxEnqueued}</b>`,
        `• پست‌های ارسال‌شده به کانال: <b>${summary.postsSent}</b> | ناموفق: <b>${summary.postsFailed}</b>`,
        settings.targetChannel
          ? `• کانال مقصد: <code>${escapeHtml(settings.targetChannel)}</code>`
          : "⚠️ کانال مقصد هنوز تنظیم نشده است (/setchannel).",
      ].join("\n");

      await completeJob(
        env.DB,
        activeRunOnceJob.id,
        lease.ownerId,
        "COMPLETED",
        `feeds=${summary.feedsChecked}, articles=${summary.articlesIngested}, sent=${summary.postsSent}`,
        nowFn()
      );
      if (activeRunOnceJob.requested_by_chat_id) {
        await telegram.sendMessage({
          chatId: activeRunOnceJob.requested_by_chat_id,
          text: reportText,
        });
      }
    }

    return summary;
  } catch (error) {
    if (error instanceof LeaseLostError) {
      await logSystemEvent(
        env.DB,
        "WARN",
        "lease",
        "Pipeline execution aborted because lease was lost",
        { ownerId, detail: error.message },
        nowFn()
      );
      return { ...summary, skippedReason: "lease_lost" };
    }

    const detail = error instanceof Error ? error.message : String(error);
    await logSystemEvent(
      env.DB,
      "ERROR",
      "pipeline",
      "Unhandled error during scheduled pipeline",
      { ownerId, detail },
      nowFn()
    );

    if (activeRunOnceJob) {
      await completeJob(
        env.DB,
        activeRunOnceJob.id,
        lease.ownerId,
        "FAILED",
        detail.slice(0, 250),
        nowFn()
      );
    }
    throw error;
  } finally {
    try {
      await releaseLease(env.DB, lease, nowFn());
    } catch {
      // Safe best-effort release
    }
  }
}

// ============================================================================
// Sub-stages
// ============================================================================

async function handleTestFeedsJob(
  env: Env,
  initialLease: LeaseContext,
  job: JobRecord,
  telegram: TelegramClient,
  deps: PipelineDependencies | undefined,
  nowFn: () => number
): Promise<LeaseContext> {
  let lease = initialLease;
  const sources = (await listActiveSources(env.DB))
    .filter((s) => s.type === "rss" || s.type === "atom")
    .slice(0, MAX_FEEDS_TO_TEST_IN_JOB);

  const lines = [`🧪 <b>نتیجه تست منابع خبری (Job #${job.id})</b>`, ""];

  if (sources.length === 0) {
    lines.push("هیچ منبع RSS/Atom فعالی برای تست وجود ندارد.");
  } else {
    for (const src of sources) {
      lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
      const res = await fetchAndParseFeed({
        url: src.url,
        etag: null,
        lastModified: null,
        maxItems: 5,
        now: nowFn(),
        fetchImpl: deps?.fetchFeed,
      });

      if (res.status === "ok") {
        lines.push(`• ✅ <b>${escapeHtml(src.name)}</b>: سالم (${res.items.length} آیتم تست)`);
      } else if (res.status === "not_modified") {
        lines.push(`• ✅ <b>${escapeHtml(src.name)}</b>: پاسخ 304 (سالم)`);
      } else {
        lines.push(
          `• ❌ <b>${escapeHtml(src.name)}</b>: خطا (<code>${escapeHtml(res.error.slice(0, 90))}</code>)`
        );
      }
    }
  }

  await completeJob(
    env.DB,
    job.id,
    lease.ownerId,
    "COMPLETED",
    `Tested ${sources.length} feeds`,
    nowFn()
  );

  if (job.requested_by_chat_id) {
    await telegram.sendMessage({
      chatId: job.requested_by_chat_id,
      text: lines.join("\n"),
    });
  }

  return lease;
}

async function handleCleanupJob(
  env: Env,
  initialLease: LeaseContext,
  job: JobRecord,
  telegram: TelegramClient,
  nowFn: () => number
): Promise<LeaseContext> {
  const lease = await renewLeaseIfNeeded(env.DB, initialLease, nowFn());
  const deletedClusters = await cleanupUnpublishedClusters(
    env.DB,
    lease,
    nowFn() - UNPUBLISHED_RETENTION_MS,
    nowFn()
  );
  const opCleanup = await cleanupOldOperationalRecords(env.DB, lease, nowFn());

  const summaryText = `clusters=${deletedClusters}, logs=${opCleanup.logsDeleted}, jobs=${opCleanup.jobsDeleted}, updates=${opCleanup.updatesDeleted}`;
  await completeJob(env.DB, job.id, lease.ownerId, "COMPLETED", summaryText, nowFn());

  if (job.requested_by_chat_id) {
    await telegram.sendMessage({
      chatId: job.requested_by_chat_id,
      text: `🧹 پاک‌سازی ایمن دیتابیس انجام شد:\n<code>${escapeHtml(summaryText)}</code>`,
    });
  }

  return lease;
}

async function ingestAndClusterNews(
  env: Env,
  initialLease: LeaseContext,
  settings: BotSettings,
  deps: PipelineDependencies | undefined,
  nowFn: () => number,
  forceIgnoreDueTime: boolean
): Promise<{
  lease: LeaseContext;
  feedsChecked: number;
  articlesIngested: number;
  clustersCreated: number;
  clustersUpdated: number;
  updateCandidates: PendingPublicationTask[];
}> {
  let lease = initialLease;
  const maxFeeds = Math.min(Math.max(settings.maxFeedsPerTick, 1), 4);
  const maxItems = Math.min(Math.max(settings.maxItemsPerFeed, 1), 25);

  const dueSources = forceIgnoreDueTime
    ? (await listActiveSources(env.DB))
        .filter((s) => s.type === "rss" || s.type === "atom")
        .sort((a, b) => a.last_fetched_at - b.last_fetched_at)
        .slice(0, maxFeeds)
    : await getDueSources(env.DB, maxFeeds, nowFn());

  const fetchedItems: Array<{ source: SourceRecord; item: RawFeedItem }> = [];
  let feedsChecked = 0;

  for (const source of dueSources) {
    lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
    feedsChecked++;

    const result = await fetchAndParseFeed({
      url: source.url,
      etag: source.etag,
      lastModified: source.last_modified,
      maxItems,
      now: nowFn(),
      fetchImpl: deps?.fetchFeed,
    });

    if (result.status === "ok") {
      await updateSourceFetchOutcome(
        env.DB,
        lease,
        {
          sourceId: source.id,
          ok: true,
          etag: result.etag,
          lastModified: result.lastModified,
          nextFetchAt: computeNextFetchTime(
            true,
            source.consecutive_failures,
            settings.checkIntervalMinutes,
            nowFn()
          ),
          error: null,
        },
        nowFn()
      );
      for (const item of result.items) {
        fetchedItems.push({ source, item });
      }
    } else if (result.status === "not_modified") {
      await updateSourceFetchOutcome(
        env.DB,
        lease,
        {
          sourceId: source.id,
          ok: true,
          etag: result.etag,
          lastModified: result.lastModified,
          nextFetchAt: computeNextFetchTime(
            true,
            source.consecutive_failures,
            settings.checkIntervalMinutes,
            nowFn()
          ),
          error: null,
        },
        nowFn()
      );
    } else {
      await updateSourceFetchOutcome(
        env.DB,
        lease,
        {
          sourceId: source.id,
          ok: false,
          etag: source.etag,
          lastModified: source.last_modified,
          nextFetchAt: computeNextFetchTime(
            false,
            source.consecutive_failures,
            settings.checkIntervalMinutes,
            nowFn()
          ),
          error: result.error,
        },
        nowFn()
      );
      await logSystemEvent(
        env.DB,
        "WARN",
        "rss",
        `Feed fetch failed for ${source.name}`,
        { sourceId: source.id, error: result.error },
        nowFn()
      );
    }
  }

  // Optional GDELT supplemental source (max 1 call every 15 minutes when enabled)
  if (settings.gdeltEnabled) {
    const lastGdeltAt = await getRuntimeNumber(env.DB, RUNTIME_LAST_GDELT_KEY);
    if (forceIgnoreDueTime || nowFn() - lastGdeltAt >= GDELT_MIN_INTERVAL_MS) {
      lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
      await setRuntimeNumber(env.DB, RUNTIME_LAST_GDELT_KEY, nowFn(), nowFn());
      const gdeltRes = await fetchGdeltArticles({
        now: nowFn(),
        fetchImpl: deps?.fetchGdelt,
      });
      if (gdeltRes.ok && gdeltRes.items.length > 0) {
        const gdeltSource = await getOrCreateGdeltSource(env.DB);
        for (const item of gdeltRes.items) {
          fetchedItems.push({
            source: {
              ...gdeltSource,
              publisher_group: item.domain || "gdelt",
            },
            item,
          });
        }
      } else if (!gdeltRes.ok) {
        await logSystemEvent(
          env.DB,
          "WARN",
          "gdelt",
          "GDELT fetch failed (continuing with RSS)",
          { error: gdeltRes.error },
          nowFn()
        );
      }
    }
  }

  if (fetchedItems.length === 0) {
    return {
      lease,
      feedsChecked,
      articlesIngested: 0,
      clustersCreated: 0,
      clustersUpdated: 0,
      updateCandidates: [],
    };
  }

  // Layer 1 Dedup: canonicalize URLs & batch-check existing url_hashes before clustering
  const preparedItems: Array<{
    source: SourceRecord;
    item: RawFeedItem;
    canonicalUrl: string;
    urlHash: string;
  }> = [];

  const seenBatchHashes = new Set<string>();
  for (const entry of fetchedItems) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeUrl(entry.item.url);
    } catch {
      continue;
    }
    const urlHash = await computeUrlHash(canonicalUrl);
    if (seenBatchHashes.has(urlHash)) continue;
    seenBatchHashes.add(urlHash);
    preparedItems.push({ ...entry, canonicalUrl, urlHash });
  }

  const existingHashes = await findExistingUrlHashes(
    env.DB,
    preparedItems.map((p) => p.urlHash)
  );
  const freshItems = preparedItems.filter((p) => !existingHashes.has(p.urlHash));

  if (freshItems.length === 0) {
    return {
      lease,
      feedsChecked,
      articlesIngested: 0,
      clustersCreated: 0,
      clustersUpdated: 0,
      updateCandidates: [],
    };
  }

  // Load up to 100 active clusters within 36-hour window for 5D matching
  const maxActiveClusters = Math.min(
    Math.max(settings.maxActiveClustersToCompare, 10),
    100
  );
  const activeRecords = await getActiveClustersForMatching(
    env.DB,
    nowFn() - CLUSTER_WINDOW_MS,
    maxActiveClusters
  );

  const candidatePool: ClusterCandidate[] = activeRecords.map((c) => ({
    id: c.id,
    primaryTitle: c.primary_title,
    category: c.category,
    entities: parseJsonStringArray(c.entities_json),
    locations: parseJsonStringArray(c.locations_json),
    concepts: parseJsonStringArray(c.concepts_json),
    eventTime: c.event_time,
  }));

  let articlesIngested = 0;
  let clustersCreated = 0;
  let clustersUpdated = 0;
  const touchedClusterIds = new Set<number>();

  for (const entry of freshItems) {
    lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());

    const features = extractStoryFeatures(entry.item.title, entry.item.summary);
    const classification = classifyArticleCategory(
      entry.item.title,
      entry.item.summary
    );
    const attribution = detectOriginAttribution({
      title: entry.item.title,
      summary: entry.item.summary,
      author: entry.item.author,
      publisherGroup: entry.source.publisher_group,
      isWireAgency: entry.source.is_wire_agency === 1,
    });

    const match = findBestMatchingCluster(
      {
        title: entry.item.title,
        category: classification.category,
        features,
        eventTime: entry.item.publishedAt,
      },
      candidatePool,
      maxActiveClusters
    );

    let clusterId: number;
    if (match) {
      clusterId = match.cluster.id;
      match.cluster.entities = mergeUniqueStrings(
        match.cluster.entities,
        features.entities,
        24
      );
      match.cluster.locations = mergeUniqueStrings(
        match.cluster.locations,
        features.locations,
        14
      );
      match.cluster.concepts = mergeUniqueStrings(
        match.cluster.concepts,
        features.concepts,
        16
      );
      clustersUpdated++;
    } else {
      const initialScore = scoreCluster({
        primaryTitle: entry.item.title,
        summaries: [entry.item.summary],
        independentSources: [
          {
            baseCredibility: entry.source.base_credibility,
            credibilityTier: entry.source.credibility_tier,
            originType: attribution.originType,
            attributionConfidence: attribution.attributionConfidence,
          },
        ],
        rawArticleCount: 1,
        eventTime: entry.item.publishedAt,
        hasExplicitDate: entry.item.hasExplicitDate,
        now: nowFn(),
      });

      const created = await createStoryCluster(
        env.DB,
        lease,
        {
          primaryTitle: entry.item.title,
          category: initialScore.category,
          entities: features.entities,
          locations: features.locations,
          concepts: features.concepts,
          eventTime: entry.item.publishedAt,
          importanceScore: initialScore.importanceScore,
          credibilityScore: initialScore.credibilityScore,
          confidenceScore: initialScore.confidenceScore,
          urgency: initialScore.urgency,
          verificationLabel: initialScore.verificationLabel,
          status: "COLLECTING",
        },
        nowFn()
      );
      clusterId = created.id;
      clustersCreated++;
      candidatePool.unshift({
        id: created.id,
        primaryTitle: created.primary_title,
        category: created.category,
        entities: features.entities,
        locations: features.locations,
        concepts: features.concepts,
        eventTime: created.event_time,
      });
    }

    const insertRes = await insertArticleAndSyncCluster(
      env.DB,
      lease,
      {
        clusterId,
        sourceId: entry.source.id,
        urlHash: entry.urlHash,
        canonicalUrl: entry.canonicalUrl,
        title: entry.item.title,
        summary: entry.item.summary,
        author: entry.item.author,
        publisherGroup: entry.source.publisher_group,
        detectedWireName: attribution.detectedWireName,
        effectiveOriginKey: attribution.effectiveOriginKey,
        originType: attribution.originType,
        attributionConfidence: attribution.attributionConfidence,
        publishedAt: entry.item.publishedAt,
      },
      nowFn()
    );

    if (insertRes.inserted) {
      articlesIngested++;
      touchedClusterIds.add(clusterId);
    }
  }

  // Re-evaluate all touched clusters using exact SSOT independent source counts
  const updateCandidates: PendingPublicationTask[] = [];
  for (const clusterId of touchedClusterIds) {
    lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
    const cluster = await getClusterById(env.DB, clusterId);
    if (!cluster) continue;

    const [articles, sourceSignals] = await Promise.all([
      getClusterArticlesWithSources(env.DB, clusterId, 15),
      getClusterIndependentSourceSignals(env.DB, clusterId),
    ]);

    const poolItem = candidatePool.find((c) => c.id === clusterId);
    const mergedEntities =
      poolItem?.entities ?? parseJsonStringArray(cluster.entities_json);
    const mergedLocations =
      poolItem?.locations ?? parseJsonStringArray(cluster.locations_json);
    const mergedConcepts =
      poolItem?.concepts ?? parseJsonStringArray(cluster.concepts_json);

    const evaluated = scoreCluster({
      primaryTitle: cluster.primary_title,
      summaries: articles.map((a) => a.summary),
      independentSources: sourceSignals.map((s) => ({
        baseCredibility: s.base_credibility,
        credibilityTier: s.credibility_tier,
        originType: s.origin_type,
        attributionConfidence: s.attribution_confidence,
      })),
      rawArticleCount: cluster.raw_article_count,
      eventTime: cluster.event_time,
      now: nowFn(),
    });

    let nextStatus = cluster.status;
    if (cluster.status === "COLLECTING" || cluster.status === "DROPPED") {
      const gate = evaluatePublishGate(evaluated, settings);
      nextStatus = gate.eligible ? "QUEUED" : evaluated.matchedAnyTargetTopic ? "COLLECTING" : "DROPPED";
    } else if (cluster.status === "PUBLISHED") {
      const pubEvents = await getClusterPublicationEvents(env.DB, cluster.id);
      const initialEvent = pubEvents[0];
      const latestEvent = pubEvents[pubEvents.length - 1];
      if (initialEvent && latestEvent) {
        const decision = evaluateUpdateMateriality({
          latestRevision: cluster.latest_revision,
          initialPublishedAt: initialEvent.published_at,
          lastPublishedAt: cluster.last_published_at ?? latestEvent.published_at,
          lastPublishedImportance:
            cluster.last_published_importance ?? latestEvent.snapshot_importance,
          lastPublishedUrgency: cluster.last_published_urgency ?? "normal",
          lastPublishedVerification:
            cluster.last_published_verification ??
            (latestEvent.snapshot_verification_label as StoryClusterRecord["verification_label"]),
          lastPublishedConcepts: parseJsonStringArray(
            cluster.last_published_concepts_json
          ),
          currentImportance: evaluated.importanceScore,
          currentUrgency: evaluated.urgency,
          currentVerification: evaluated.verificationLabel,
          currentConcepts: mergedConcepts,
          currentIndependentSources: sourceSignals.length,
          previousIndependentSources: latestEvent.snapshot_independent_sources,
          settings,
          now: nowFn(),
        });

        if (decision.shouldUpdate) {
          const reasonText =
            settings.language === "fa" ? decision.reasonFa : decision.reasonEn;
          updateCandidates.push({
            clusterId: cluster.id,
            eventType: "UPDATE",
            revisionNumber: cluster.latest_revision + 1,
            updateReason: reasonText,
            replyToMessageId: initialEvent.telegram_message_id,
          });
        }
      }
    }

    await updateClusterEvaluation(
      env.DB,
      lease,
      {
        clusterId: cluster.id,
        category: evaluated.category,
        entities: mergedEntities,
        locations: mergedLocations,
        concepts: mergedConcepts,
        importanceScore: evaluated.importanceScore,
        credibilityScore: evaluated.credibilityScore,
        confidenceScore: evaluated.confidenceScore,
        urgency: evaluated.urgency,
        verificationLabel: evaluated.verificationLabel,
        status: nextStatus,
      },
      nowFn()
    );
  }

  return {
    lease,
    feedsChecked,
    articlesIngested,
    clustersCreated,
    clustersUpdated,
    updateCandidates,
  };
}

async function analyzeAndEnqueuePublications(
  env: Env,
  initialLease: LeaseContext,
  settings: BotSettings,
  updateCandidates: readonly PendingPublicationTask[],
  deps: PipelineDependencies | undefined,
  nowFn: () => number
): Promise<{
  lease: LeaseContext;
  geminiCalls: number;
  outboxEnqueued: number;
}> {
  let lease = initialLease;
  const targetChannel = settings.targetChannel;
  if (!targetChannel) {
    return { lease, geminiCalls: 0, outboxEnqueued: 0 };
  }

  const counts = await getPublishedCounts(env.DB, nowFn());
  const remainingHour = Math.max(0, settings.maxPostsPerHour - counts.lastHour);
  const remainingDay = Math.max(0, settings.maxPostsPerDay - counts.last24Hours);
  const slotsAvailable = Math.min(
    MAX_GEMINI_CALLS_PER_TICK,
    remainingHour,
    remainingDay
  );

  if (slotsAvailable <= 0) {
    return { lease, geminiCalls: 0, outboxEnqueued: 0 };
  }

  const tasks: PendingPublicationTask[] = [...updateCandidates.slice(0, slotsAvailable)];
  if (tasks.length < slotsAvailable) {
    const queuedClusters = await getQueuedClustersForPublishing(
      env.DB,
      slotsAvailable - tasks.length
    );
    for (const c of queuedClusters) {
      tasks.push({
        clusterId: c.id,
        eventType: "INITIAL",
        revisionNumber: Math.max(1, c.latest_revision + 1),
        updateReason: null,
        replyToMessageId: null,
      });
    }
  }

  let geminiCalls = 0;
  let outboxEnqueued = 0;

  for (const task of tasks) {
    lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
    const cluster = await getClusterById(env.DB, task.clusterId);
    if (!cluster) continue;

    const articles = await getClusterArticlesWithSources(env.DB, cluster.id, 6);
    if (articles.length === 0) continue;

    let analysis: GeminiAnalysisOutput | null = null;
    let shouldDeferInQueue = false;

    if (settings.geminiEnabled && geminiCalls < MAX_GEMINI_CALLS_PER_TICK) {
      const quotaCheck = await checkGeminiQuotaAndCooldown(
        env.DB,
        settings.geminiDailyLimit,
        nowFn()
      );

      if (!quotaCheck.allowed) {
        await logSystemEvent(
          env.DB,
          "WARN",
          "gemini",
          quotaCheck.detail,
          { clusterId: cluster.id, code: quotaCheck.code },
          nowFn()
        );
        if (settings.geminiFallbackBehavior === "queue") {
          shouldDeferInQueue = true;
        }
      } else {
        lease = await renewLeaseIfNeeded(env.DB, lease, nowFn());
        const aiRes = await analyzeClusterWithGemini({
          apiKey: env.GEMINI_API_KEY,
          primaryModel: settings.geminiModel,
          fallbackModel: settings.geminiFallbackModel,
          emergencyModel: settings.geminiEmergencyModel,
          language: settings.language,
          analysisLength: settings.analysisLength,
          category: cluster.category,
          verificationLabel: cluster.verification_label,
          independentSourceCount: Math.max(1, cluster.independent_source_count),
          isUpdate: task.eventType === "UPDATE",
          updateReason: task.updateReason,
          articles: articles.map((a) => ({
            sourceName: a.source_name,
            title: a.title,
            summary: a.summary,
            publishedAtIso: new Date(a.published_at).toISOString(),
          })),
          fetchImpl: deps?.fetchGemini,
        });

        geminiCalls++;
        if (aiRes.attempts > 0) {
          await recordGeminiUsage(env.DB, aiRes.attempts, nowFn());
        }

        if (aiRes.ok) {
          analysis = aiRes.analysis;
          await saveClusterAiResult(
            env.DB,
            lease,
            cluster.id,
            JSON.stringify(aiRes.analysis),
            aiRes.attempts,
            nowFn()
          );
        } else {
          await saveClusterAiResult(env.DB, lease, cluster.id, null, aiRes.attempts, nowFn());
          if (aiRes.code === "RATE_LIMITED") {
            await setGeminiCooldown(
              env.DB,
              aiRes.retryAfterSeconds ?? 300,
              nowFn()
            );
          }
          await logSystemEvent(
            env.DB,
            "WARN",
            "gemini",
            `Gemini failed (${aiRes.code}): ${aiRes.detail.slice(0, 260)}`,
            {
              clusterId: cluster.id,
              code: aiRes.code,
              attempts: aiRes.attempts,
              modelErrors: aiRes.modelErrors,
            },
            nowFn()
          );
          if (settings.geminiFallbackBehavior === "queue") {
            shouldDeferInQueue = true;
          }
        }
      }
    }

    if (shouldDeferInQueue) {
      continue;
    }

    const fallbackSummary =
      articles.find((a) => a.summary && a.summary.trim().length > 0)?.summary ??
      null;

    const html = formatNewsPost({
      language: settings.language,
      eventType: task.eventType,
      revisionNumber: task.revisionNumber,
      updateReason: task.updateReason,
      primaryTitle: cluster.primary_title,
      fallbackSummary,
      category: cluster.category,
      urgency: cluster.urgency,
      importanceScore: cluster.importance_score,
      credibilityScore: cluster.credibility_score,
      confidenceScore: cluster.confidence_score,
      independentSourceCount: Math.max(1, cluster.independent_source_count),
      rawArticleCount: Math.max(1, cluster.raw_article_count),
      verificationLabel: cluster.verification_label,
      analysis,
      sources: buildSourceLinks(articles),
      eventTime: cluster.event_time,
      publishedAt: nowFn(),
      channelId: targetChannel,
    });

    const outboxRow = await enqueueOutboxDelivery(
      env.DB,
      lease,
      {
        clusterId: cluster.id,
        revisionNumber: task.revisionNumber,
        eventType: task.eventType,
        updateReason: task.updateReason,
        channelId: targetChannel,
        replyToMessageId: task.replyToMessageId,
        language: settings.language,
        hasAiAnalysis: analysis !== null,
        renderedHtml: html,
      },
      nowFn()
    );

    if (outboxRow) {
      outboxEnqueued++;
    }
  }

  return { lease, geminiCalls, outboxEnqueued };
}

function buildSourceLinks(
  articles: readonly ClusterArticleWithSource[]
): Array<{ name: string; url: string }> {
  const links: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();
  for (const a of articles) {
    if (seen.has(a.canonical_url)) continue;
    seen.add(a.canonical_url);
    links.push({ name: a.source_name, url: a.canonical_url });
  }
  return links;
}

async function dispatchPendingOutbox(
  env: Env,
  initialLease: LeaseContext,
  settings: BotSettings,
  telegram: TelegramClient,
  nowFn: () => number
): Promise<{
  lease: LeaseContext;
  postsSent: number;
  postsFailed: number;
}> {
  let lease = initialLease;
  let postsSent = 0;
  let postsFailed = 0;

  const counts = await getPublishedCounts(env.DB, nowFn());
  const remainingHour = Math.max(0, settings.maxPostsPerHour - counts.lastHour);
  const remainingDay = Math.max(0, settings.maxPostsPerDay - counts.last24Hours);
  const maxToSend = Math.min(
    MAX_OUTBOX_DISPATCH_PER_TICK,
    remainingHour,
    remainingDay
  );

  if (maxToSend <= 0) {
    return { lease, postsSent, postsFailed };
  }

  const pendingItems = await listDispatchableOutbox(env.DB, maxToSend, nowFn());

  for (const item of pendingItems) {
    // Guarantee >45s main lease margin before transitioning PENDING -> SENDING
    lease = await renewLease(env.DB, lease, nowFn());

    const attemptToken = crypto.randomUUID();
    const claimed = await claimOutboxForSending(
      env.DB,
      lease,
      item.id,
      attemptToken,
      nowFn()
    );
    if (!claimed) continue;

    const sendRes = await telegram.sendMessage({
      chatId: claimed.channel_id,
      text: claimed.rendered_html,
      parseMode: "HTML",
      replyToMessageId: claimed.reply_to_message_id,
      disableWebPagePreview: true,
    });

    if (sendRes.ok) {
      const cluster = await getClusterById(env.DB, claimed.cluster_id);
      await markOutboxSentAndRecordPublication(
        env.DB,
        {
          outboxId: claimed.id,
          attemptToken,
          telegramMessageId: sendRes.messageId,
          snapshot: {
            importance: cluster?.importance_score ?? 0,
            credibility: cluster?.credibility_score ?? 0,
            confidence: cluster?.confidence_score ?? 0,
            independentSources: Math.max(1, cluster?.independent_source_count ?? 1),
            verificationLabel: cluster?.verification_label ?? "single_source",
            urgency: cluster?.urgency ?? "normal",
            conceptsJson: cluster?.concepts_json ?? "[]",
          },
        },
        nowFn()
      );
      postsSent++;
      continue;
    }

    if (sendRes.kind === "retryable") {
      if (claimed.attempt_count >= 3) {
        await markOutboxFailed(
          env.DB,
          claimed.id,
          attemptToken,
          "PERMANENT_TELEGRAM_ERROR",
          `Rate limited after ${claimed.attempt_count} attempts: ${sendRes.detail}`,
          nowFn()
        );
        postsFailed++;
        await notifyAdminsAboutFailedOutbox(env, telegram, claimed, false, sendRes.detail);
      } else {
        await markOutboxRetryable(
          env.DB,
          claimed.id,
          attemptToken,
          nowFn() + sendRes.retryAfterSeconds * 1000,
          sendRes.detail,
          nowFn()
        );
      }
      continue;
    }

    // Permanent (4xx) or Ambiguous (timeout / network / 5xx): NEVER auto-retry
    await markOutboxFailed(
      env.DB,
      claimed.id,
      attemptToken,
      sendRes.code,
      sendRes.detail,
      nowFn()
    );
    postsFailed++;

    await logSystemEvent(
      env.DB,
      "ERROR",
      "outbox",
      `Telegram dispatch failed for outbox #${claimed.id} (${sendRes.code})`,
      {
        outboxId: claimed.id,
        clusterId: claimed.cluster_id,
        attemptToken,
        code: sendRes.code,
        detail: sendRes.detail,
      },
      nowFn()
    );

    await notifyAdminsAboutFailedOutbox(
      env,
      telegram,
      claimed,
      sendRes.kind === "ambiguous",
      sendRes.detail
    );
  }

  return { lease, postsSent, postsFailed };
}

async function notifyAdminsAboutFailedOutbox(
  env: Env,
  telegram: TelegramClient,
  outbox: OutboxRecord,
  isAmbiguous: boolean,
  detail?: string
): Promise<void> {
  const adminIds = [...parseAdminUserIds(env.ADMIN_USER_IDS)];
  if (adminIds.length === 0) return;

  const text = isAmbiguous
    ? [
        `⚠️ <b>هشدار ارسال مبهم به تلگرام (Outbox #${outbox.id})</b>`,
        `• خوشه: <code>#${outbox.cluster_id}</code> | نسخه: <code>${outbox.revision_number}</code>`,
        `• کانال: <code>${escapeHtml(outbox.channel_id)}</code>`,
        detail ? `• جزئیات: <code>${escapeHtml(detail.slice(0, 180))}</code>` : "",
        "",
        "به‌دلیل احتمال انتشار پیام پیش از خطا/تایم‌اوت، ارسال مجدد خودکار متوقف شد.",
        "لطفاً کانال را بررسی کنید و اگر پست منتشر نشده است، دکمه زیر را بزنید:",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        `❌ <b>خطای قطعی در ارسال به کانال (Outbox #${outbox.id})</b>`,
        `• خوشه: <code>#${outbox.cluster_id}</code> | کانال: <code>${escapeHtml(outbox.channel_id)}</code>`,
        detail ? `• خطا: <code>${escapeHtml(detail.slice(0, 180))}</code>` : "",
      ]
        .filter(Boolean)
        .join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        {
          text: `🔁 تأیید ارسال مجدد دستی Outbox #${outbox.id}`,
          callback_data: `p:retry:${outbox.id}`,
        },
      ],
    ],
  };

  // Notify primary admin (bounded to max 2 admins to protect subrequest budget)
  for (const adminId of adminIds.slice(0, 2)) {
    await telegram.sendMessage({
      chatId: adminId,
      text,
      replyMarkup,
    });
  }
}