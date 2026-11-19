import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLease,
  archiveSourceByUrl,
  claimNextJob,
  claimOutboxForSending,
  cleanupUnpublishedClusters,
  completeJob,
  createStoryCluster,
  enqueueJob,
  enqueueOutboxDelivery,
  failExhaustedJobs,
  failStuckSendingOutbox,
  getClusterById,
  getClusterSources,
  getRecentLogs,
  getSettings,
  insertArticleAndSyncCluster,
  manualRetryOutbox,
  markOutboxFailed,
  markOutboxSentAndRecordPublication,
  recordTelegramUpdateIfNew,
  releaseLease,
  renewLease,
  seedDefaultSettings,
  setSetting,
  upsertSource,
} from "../src/database";
import { DEFAULT_SETTINGS, LeaseLostError } from "../src/types";
import { createTestD1 } from "./helpers/sqlite-d1";

describe("Phase 2 D1 Database Layer", () => {
  let db: D1Database;
  let closeDb: () => void;

  beforeEach(async () => {
    const testDb = await createTestD1();
    db = testDb.db;
    closeDb = testDb.close;
  });

  afterEach(() => {
    closeDb();
  });

  it("handles Settings CRUD with defaults", async () => {
    await seedDefaultSettings(db, 1_000);
    const initial = await getSettings(db);
    expect(initial.maxFeedsPerTick).toBe(2);
    expect(initial.language).toBe("fa");
    expect(initial.enabledCategories).toEqual(DEFAULT_SETTINGS.enabledCategories);

    await setSetting(db, "targetChannel", "@world_intel_test", 2_000);
    await setSetting(db, "language", "en", 2_000);
    await setSetting(db, "minImportanceScore", 75, 2_000);

    const updated = await getSettings(db);
    expect(updated.targetChannel).toBe("@world_intel_test");
    expect(updated.language).toBe("en");
    expect(updated.minImportanceScore).toBe(75);
  });

  it("enforces atomic lease lock, monotonic fencing token, renew without token change, and crash recovery", async () => {
    const lease1 = await acquireLease(db, "worker-1", 10_000, 90_000);
    expect(lease1).not.toBeNull();
    expect(lease1?.fencingToken).toBe(1);

    // Concurrent worker cannot acquire active lease
    const blocked = await acquireLease(db, "worker-2", 20_000, 90_000);
    expect(blocked).toBeNull();

    // Renew extends expiry without changing fencing_token
    const renewed = await renewLease(db, lease1!, 50_000, 90_000);
    expect(renewed.fencingToken).toBe(1);
    expect(renewed.expiresAt).toBe(140_000);

    // Wrong owner cannot release
    const wrongRelease = await releaseLease(
      db,
      { ...renewed, ownerId: "worker-2" },
      60_000
    );
    expect(wrongRelease).toBe(false);

    // Simulate crash: worker-1 never releases; after expiry (140_000), worker-2 takes over with token=2
    const lease2 = await acquireLease(db, "worker-2", 140_000, 90_000);
    expect(lease2).not.toBeNull();
    expect(lease2?.ownerId).toBe("worker-2");
    expect(lease2?.fencingToken).toBe(2);

    // Stale worker-1 cannot renew after losing lease
    await expect(renewLease(db, renewed, 150_000, 90_000)).rejects.toBeInstanceOf(
      LeaseLostError
    );

    // Proper release keeps row (expires_at = 0) so next acquire increments token to 3
    expect(await releaseLease(db, lease2!, 150_000)).toBe(true);
    const lease3 = await acquireLease(db, "worker-3", 151_000, 90_000);
    expect(lease3?.fencingToken).toBe(3);
  });

  it("enforces UNIQUE url_hash, idempotent SSOT independent_source_count, and fencing on writes", async () => {
    const lease = (await acquireLease(db, "worker-1", 1_000, 90_000))!;
    const srcA = await upsertSource(db, {
      name: "Agency A",
      url: "https://example-a.com/rss.xml",
      type: "rss",
      publisherGroup: "group-a",
      credibilityTier: 1,
      baseCredibility: 88,
    });
    const srcB = await upsertSource(db, {
      name: "Site B (syndicating Reuters)",
      url: "https://example-b.com/rss.xml",
      type: "rss",
      publisherGroup: "group-b",
      credibilityTier: 2,
      baseCredibility: 75,
    });
    const srcC = await upsertSource(db, {
      name: "Site C (also syndicating Reuters)",
      url: "https://example-c.com/rss.xml",
      type: "rss",
      publisherGroup: "group-c",
      credibilityTier: 2,
      baseCredibility: 74,
    });

    const cluster = await createStoryCluster(
      db,
      lease,
      {
        primaryTitle: "Major missile strike reported",
        category: "missile_drone",
        entities: ["entity_a"],
        locations: ["loc_a"],
        concepts: ["CONCEPT_STRIKE"],
        eventTime: 1_000,
        importanceScore: 85,
        credibilityScore: 80,
        confidenceScore: 60,
        urgency: "high",
        verificationLabel: "single_source",
      },
      1_000
    );

    // First article from group-a
    const res1 = await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: cluster.id,
        sourceId: srcA.id,
        urlHash: "hash-1",
        canonicalUrl: "https://example-a.com/story-1",
        title: "Major missile strike reported",
        summary: "Details from Agency A",
        author: null,
        publisherGroup: "group-a",
        detectedWireName: null,
        effectiveOriginKey: "pub:group-a",
        originType: "publisher_group",
        attributionConfidence: "high",
        publishedAt: 1_000,
      },
      1_000
    );
    expect(res1.inserted).toBe(true);

    // Re-processing duplicate url_hash must NOT increment counters
    const dupRes = await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: cluster.id,
        sourceId: srcA.id,
        urlHash: "hash-1",
        canonicalUrl: "https://example-a.com/story-1",
        title: "Major missile strike reported",
        summary: "Details from Agency A",
        author: null,
        publisherGroup: "group-a",
        detectedWireName: null,
        effectiveOriginKey: "pub:group-a",
        originType: "publisher_group",
        attributionConfidence: "high",
        publishedAt: 1_000,
      },
      1_500
    );
    expect(dupRes.inserted).toBe(false);

    // Two different sites both attributing the same wire ("wire:reuters") count as ONE independent source
    await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: cluster.id,
        sourceId: srcB.id,
        urlHash: "hash-2",
        canonicalUrl: "https://example-b.com/story-2",
        title: "Missile strike reported (Reuters)",
        summary: "Via Reuters",
        author: "Reuters",
        publisherGroup: "group-b",
        detectedWireName: "reuters",
        effectiveOriginKey: "wire:reuters",
        originType: "wire_heuristic",
        attributionConfidence: "high",
        publishedAt: 1_100,
      },
      1_600
    );
    await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: cluster.id,
        sourceId: srcC.id,
        urlHash: "hash-3",
        canonicalUrl: "https://example-c.com/story-3",
        title: "Missile strike reported - Reuters",
        summary: "According to Reuters",
        author: "Reuters",
        publisherGroup: "group-c",
        detectedWireName: "reuters",
        effectiveOriginKey: "wire:reuters",
        originType: "wire_heuristic",
        attributionConfidence: "high",
        publishedAt: 1_200,
      },
      1_700
    );

    const syncedCluster = await getClusterById(db, cluster.id);
    const sources = await getClusterSources(db, cluster.id);
    expect(syncedCluster?.raw_article_count).toBe(3);
    expect(syncedCluster?.independent_source_count).toBe(2);
    expect(sources).toHaveLength(2);
    expect(
      sources.find((s) => s.effective_origin_key === "wire:reuters")?.article_count
    ).toBe(2);

    // Direct duplicate insert at SQL level fails UNIQUE constraint
    await expect(
      db
        .prepare(
          `INSERT INTO articles (
             cluster_id, source_id, url_hash, canonical_url, title,
             publisher_group, effective_origin_key, published_at, fetched_at
           ) VALUES (?, ?, 'hash-1', 'https://dup', 'Dup', 'g', 'pub:g', 1, 1)`
        )
        .bind(cluster.id, srcA.id)
        .run()
    ).rejects.toThrow();

    // Stale lease cannot mutate cluster
    await expect(
      insertArticleAndSyncCluster(
        db,
        { ...lease, fencingToken: 999 },
        {
          clusterId: cluster.id,
          sourceId: srcA.id,
          urlHash: "hash-4",
          canonicalUrl: "https://example-a.com/story-4",
          title: "Should be rejected",
          summary: null,
          author: null,
          publisherGroup: "group-a",
          detectedWireName: null,
          effectiveOriginKey: "pub:group-a",
          originType: "publisher_group",
          attributionConfidence: "high",
          publishedAt: 1_300,
        },
        1_800
      )
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("preserves history with soft delete and blocks physical source deletion via ON DELETE RESTRICT", async () => {
    const lease = (await acquireLease(db, "worker-1", 1_000, 90_000))!;
    const source = await upsertSource(db, {
      name: "BBC World",
      url: "https://feeds.bbci.co.uk/news/world/rss.xml",
      type: "rss",
      publisherGroup: "bbc",
      credibilityTier: 1,
      baseCredibility: 90,
    });
    const cluster = await createStoryCluster(
      db,
      lease,
      {
        primaryTitle: "Energy crisis update",
        category: "energy_oil_gas",
        entities: [],
        locations: [],
        concepts: [],
        eventTime: 1_000,
        importanceScore: 70,
        credibilityScore: 90,
        confidenceScore: 70,
        urgency: "normal",
        verificationLabel: "single_source",
      },
      1_000
    );
    await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: cluster.id,
        sourceId: source.id,
        urlHash: "bbc-hash-1",
        canonicalUrl: "https://bbc.co.uk/news/1",
        title: "Energy crisis update",
        summary: null,
        author: null,
        publisherGroup: "bbc",
        detectedWireName: null,
        effectiveOriginKey: "pub:bbc",
        originType: "publisher_group",
        attributionConfidence: "high",
        publishedAt: 1_000,
      },
      1_000
    );

    // Physical DELETE must fail due to ON DELETE RESTRICT
    await expect(
      db.prepare(`DELETE FROM sources WHERE id = ?`).bind(source.id).run()
    ).rejects.toThrow();

    // Soft-delete archives source while keeping articles intact
    expect(await archiveSourceByUrl(db, source.url, 2_000)).toBe(true);
    const reactivated = await upsertSource(db, {
      name: "BBC World",
      url: source.url,
      type: "rss",
      publisherGroup: "bbc",
      credibilityTier: 1,
      baseCredibility: 90,
    });
    expect(reactivated.id).toBe(source.id);
    expect(reactivated.status).toBe("ACTIVE");
  });

  it("manages Outbox delivery states, crash ambiguity, manual retry audit log, and safe cleanup order", async () => {
    const lease = (await acquireLease(db, "worker-1", 10_000, 90_000))!;
    const source = await upsertSource(db, {
      name: "Source 1",
      url: "https://src1.example/rss",
      type: "rss",
      publisherGroup: "src1",
      credibilityTier: 1,
      baseCredibility: 85,
    });

    // Cluster 1: will be published (must NEVER be deleted by cleanup)
    const publishedCluster = await createStoryCluster(
      db,
      lease,
      {
        primaryTitle: "Published event",
        category: "geopolitics_diplomacy",
        entities: [],
        locations: [],
        concepts: ["CONCEPT_SANCTION"],
        eventTime: 1_000,
        importanceScore: 80,
        credibilityScore: 85,
        confidenceScore: 80,
        urgency: "high",
        verificationLabel: "corroborated",
      },
      1_000
    );
    await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: publishedCluster.id,
        sourceId: source.id,
        urlHash: "pub-hash-1",
        canonicalUrl: "https://src1.example/1",
        title: "Published event",
        summary: null,
        author: null,
        publisherGroup: "src1",
        detectedWireName: null,
        effectiveOriginKey: "pub:src1",
        originType: "publisher_group",
        attributionConfidence: "high",
        publishedAt: 1_000,
      },
      10_000
    );

    // Cluster 2: old unpublished cluster (MUST be deleted cleanly in proper FK order)
    const oldDroppedCluster = await createStoryCluster(
      db,
      lease,
      {
        primaryTitle: "Old noise",
        category: "economy_finance",
        entities: [],
        locations: [],
        concepts: [],
        eventTime: 1_000,
        importanceScore: 20,
        credibilityScore: 50,
        confidenceScore: 40,
        urgency: "low",
        verificationLabel: "unverified",
        status: "DROPPED",
      },
      1_000
    );
    await insertArticleAndSyncCluster(
      db,
      lease,
      {
        clusterId: oldDroppedCluster.id,
        sourceId: source.id,
        urlHash: "drop-hash-1",
        canonicalUrl: "https://src1.example/2",
        title: "Old noise",
        summary: null,
        author: null,
        publisherGroup: "src1",
        detectedWireName: null,
        effectiveOriginKey: "pub:src1",
        originType: "publisher_group",
        attributionConfidence: "high",
        publishedAt: 1_000,
      },
      10_000
    );

    const outbox = await enqueueOutboxDelivery(
      db,
      lease,
      {
        clusterId: publishedCluster.id,
        revisionNumber: 1,
        eventType: "INITIAL",
        updateReason: null,
        channelId: "@test_channel",
        replyToMessageId: null,
        language: "fa",
        hasAiAnalysis: true,
        renderedHtml: "<b>Test</b>",
      },
      10_000
    );
    expect(outbox).not.toBeNull();

    // Claim for sending -> simulate crash -> failStuckSendingOutbox -> manualRetry with audit log -> send success
    const claimed = await claimOutboxForSending(
      db,
      lease,
      outbox!.id,
      "attempt-tok-1",
      11_000
    );
    expect(claimed?.status).toBe("SENDING");

    // Simulate crash past 30s sending lease
    const stuck = await failStuckSendingOutbox(db, lease, 45_000);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.failure_code).toBe("AMBIGUOUS_DELIVERY_STATE");

    // Admin manually approves retry
    expect(await manualRetryOutbox(db, outbox!.id, "123456789", 46_000)).toBe(true);
    const logs = await getRecentLogs(db, 5);
    expect(logs[0]?.component).toBe("outbox_manual_retry");
    expect(logs[0]?.meta_json).toContain("attempt-tok-1");
    expect(logs[0]?.meta_json).toContain("123456789");

    // Renew main lease so >45s margin is available before sending
    const freshLease = await renewLease(db, lease, 50_000, 90_000);
    const claimed2 = await claimOutboxForSending(
      db,
      freshLease,
      outbox!.id,
      "attempt-tok-2",
      50_000
    );
    expect(claimed2?.attempt_count).toBe(2);

    const sentOk = await markOutboxSentAndRecordPublication(
      db,
      {
        outboxId: outbox!.id,
        attemptToken: "attempt-tok-2",
        telegramMessageId: 777,
        snapshot: {
          importance: 80,
          credibility: 85,
          confidence: 80,
          independentSources: 1,
          verificationLabel: "corroborated",
          urgency: "high",
          conceptsJson: JSON.stringify(["CONCEPT_SANCTION"]),
        },
      },
      51_000
    );
    expect(sentOk).toBe(true);

    // Cleanup removes oldDroppedCluster cleanly and preserves publishedCluster
    const deletedCount = await cleanupUnpublishedClusters(
      db,
      freshLease,
      5_000,
      52_000
    );
    expect(deletedCount).toBe(1);
    expect(await getClusterById(db, oldDroppedCluster.id)).toBeNull();
    expect((await getClusterById(db, publishedCluster.id))?.status).toBe("PUBLISHED");

    // Outbox failure helper works on separate item
    const outbox2 = await enqueueOutboxDelivery(
      db,
      freshLease,
      {
        clusterId: publishedCluster.id,
        revisionNumber: 2,
        eventType: "UPDATE",
        updateReason: "New confirmation",
        channelId: "@test_channel",
        replyToMessageId: 777,
        language: "fa",
        hasAiAnalysis: false,
        renderedHtml: "<b>Update</b>",
      },
      52_000
    );
    await claimOutboxForSending(db, freshLease, outbox2!.id, "tok-fail", 52_000);
    expect(
      await markOutboxFailed(
        db,
        outbox2!.id,
        "tok-fail",
        "PERMANENT_TELEGRAM_ERROR",
        "403 Forbidden",
        53_000
      )
    ).toBe(true);
  });

  it("handles async job queue claiming, crash recovery, poison-pill exhaustion, and webhook replay dedup", async () => {
    const lease = (await acquireLease(db, "worker-1", 1_000, 90_000))!;
    const job = await enqueueJob(
      db,
      { type: "RUN_ONCE", priority: 1, requestedByChatId: "12345", maxAttempts: 2 },
      1_000
    );
    expect(job.status).toBe("PENDING");

    // Attempt 1 claimed, then worker crashes past lease
    const run1 = await claimNextJob(db, lease, 10_000, 2_000);
    expect(run1?.attempt_count).toBe(1);

    // Attempt 2 recovered after expiry
    const run2 = await claimNextJob(db, lease, 10_000, 15_000);
    expect(run2?.attempt_count).toBe(2);

    // After 2nd crash, job is marked FAILED (poison pill protection)
    const failed = await failExhaustedJobs(db, lease, 30_000);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("FAILED");

    // Successful job completion
    const job2 = await enqueueJob(db, { type: "TEST_FEEDS" }, 31_000);
    const claimed2 = await claimNextJob(db, lease, 10_000, 32_000);
    expect(claimed2?.id).toBe(job2.id);
    expect(
      await completeJob(db, job2.id, lease.ownerId, "COMPLETED", "All OK", 33_000)
    ).toBe(true);

    // Anti-replay for Telegram update_id
    expect(await recordTelegramUpdateIfNew(db, 90001, 33_000)).toBe(true);
    expect(await recordTelegramUpdateIfNew(db, 90001, 34_000)).toBe(false);
  });
});