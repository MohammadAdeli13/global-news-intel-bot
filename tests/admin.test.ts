import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTelegramUpdate } from "../src/admin";
import {
  acquireLease,
  claimOutboxForSending,
  createStoryCluster,
  enqueueOutboxDelivery,
  getRecentLogs,
  getSettings,
  listActiveSources,
  markOutboxFailed,
} from "../src/database";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { FetchLike, HttpResponseLike, TelegramUpdate } from "../src/telegram";
import { createTestD1 } from "./helpers/sqlite-d1";

interface RecordedTelegramCall {
  method: string;
  body: Record<string, unknown>;
}

function createMockTelegramFetch(
  overrides?: Partial<Record<string, unknown>>
): { fetchImpl: FetchLike; calls: RecordedTelegramCall[] } {
  const calls: RecordedTelegramCall[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const parsedBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body: parsedBody });

    let responsePayload: unknown = { ok: true, result: { message_id: 100 } };
    if (overrides && method in overrides) {
      responsePayload = overrides[method];
    } else if (method === "getMe") {
      responsePayload = { ok: true, result: { id: 999, is_bot: true, first_name: "NewsBot" } };
    } else if (method === "getChat") {
      responsePayload = {
        ok: true,
        result: { id: -1001987654321, type: "channel", title: "World Intel" },
      };
    } else if (method === "getChatMember") {
      responsePayload = {
        ok: true,
        result: { status: "administrator", can_post_messages: true },
      };
    } else if (method === "answerCallbackQuery" || method === "editMessageText") {
      responsePayload = { ok: true, result: true };
    }

    const res: HttpResponseLike = {
      ok: true,
      status: 200,
      async json() {
        return responsePayload;
      },
      async text() {
        return JSON.stringify(responsePayload);
      },
    };
    return res;
  };

  return { fetchImpl, calls };
}

function makeMessageUpdate(updateId: number, userId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: "Tester" },
      chat: { id: userId, type: "private" },
      date: 1700000000,
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, userId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 50,
        chat: { id: userId, type: "private" },
        date: 1700000000,
      },
      data,
    },
  };
}

describe("Phase 3 Webhook Security & Admin Panel", () => {
  let db: D1Database;
  let closeDb: () => void;
  let env: Env;

  beforeEach(async () => {
    const testDb = await createTestD1();
    db = testDb.db;
    closeDb = testDb.close;
    env = {
      DB: db,
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_WEBHOOK_SECRET: "secret-token-123",
      ADMIN_USER_IDS: "111222333",
      GEMINI_API_KEY: "test-gemini",
      ENVIRONMENT: "test",
    };
  });

  afterEach(() => {
    closeDb();
  });

  it("rejects webhook requests with missing or wrong secret and deduplicates update_id", async () => {
    const mockCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;

    const noSecretRes = await worker.fetch(
      new Request("https://example.com/webhook", {
        method: "POST",
        body: JSON.stringify({ update_id: 1 }),
      }),
      env,
      mockCtx
    );
    expect(noSecretRes.status).toBe(401);

    const wrongSecretRes = await worker.fetch(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: JSON.stringify({ update_id: 1 }),
      }),
      env,
      mockCtx
    );
    expect(wrongSecretRes.status).toBe(401);

    // Valid secret + empty update (no Telegram network call needed)
    const firstRes = await worker.fetch(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret-token-123" },
        body: JSON.stringify({ update_id: 5001 }),
      }),
      env,
      mockCtx
    );
    expect(firstRes.status).toBe(200);

    // Replay with same update_id is cleanly ignored
    const dupRes = await worker.fetch(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret-token-123" },
        body: JSON.stringify({ update_id: 5001 }),
      }),
      env,
      mockCtx
    );
    expect(dupRes.status).toBe(200);
    expect(await dupRes.json()).toEqual({ ok: true, duplicate: true });
  });

  it("allows /myid for everyone, blocks non-admins on admin commands", async () => {
    const { fetchImpl, calls } = createMockTelegramFetch();

    await handleTelegramUpdate(makeMessageUpdate(1, 999888777, "/myid"), env, { fetchImpl });
    expect(calls[0]?.method).toBe("sendMessage");
    expect(String(calls[0]?.body.text)).toContain("999888777");

    await handleTelegramUpdate(makeMessageUpdate(2, 999888777, "/pause"), env, { fetchImpl });
    expect(String(calls[1]?.body.text)).toContain("مجوز دسترسی");
    const settings = await getSettings(db);
    expect(settings.isPaused).toBe(false);
  });

  it("verifies bot admin permission in /setchannel for both @username and private -100 ID", async () => {
    const { fetchImpl, calls } = createMockTelegramFetch();

    await handleTelegramUpdate(
      makeMessageUpdate(10, 111222333, "/setchannel @world_intel_ch"),
      env,
      { fetchImpl }
    );
    expect((await getSettings(db)).targetChannel).toBe("@world_intel_ch");
    expect(calls.some((c) => c.method === "getChatMember")).toBe(true);

    // Private numeric channel
    await handleTelegramUpdate(
      makeMessageUpdate(11, 111222333, "/setchannel -1001987654321"),
      env,
      { fetchImpl }
    );
    expect((await getSettings(db)).targetChannel).toBe("-1001987654321");

    // Reject if bot lacks can_post_messages
    const noPermMock = createMockTelegramFetch({
      getChatMember: {
        ok: true,
        result: { status: "administrator", can_post_messages: false },
      },
    });
    await handleTelegramUpdate(
      makeMessageUpdate(12, 111222333, "/setchannel @no_perm_channel"),
      env,
      { fetchImpl: noPermMock.fetchImpl }
    );
    expect((await getSettings(db)).targetChannel).toBe("-1001987654321");
  });

  it("handles /addfeed (with SSRF guard), /removefeed (soft archive), and /runonce (DB job)", async () => {
    const { fetchImpl } = createMockTelegramFetch();

    // Blocked internal URL
    await handleTelegramUpdate(
      makeMessageUpdate(20, 111222333, "/addfeed https://127.0.0.1/secret"),
      env,
      { fetchImpl }
    );
    expect(await listActiveSources(db)).toHaveLength(0);

    // Valid feed
    await handleTelegramUpdate(
      makeMessageUpdate(21, 111222333, "/addfeed https://feeds.bbci.co.uk/news/world/rss.xml BBC World"),
      env,
      { fetchImpl }
    );
    const active = await listActiveSources(db);
    expect(active).toHaveLength(1);
    expect(active[0]?.name).toBe("BBC World");

    // Soft-archive via /removefeed
    await handleTelegramUpdate(
      makeMessageUpdate(22, 111222333, `/removefeed ${active[0]!.id}`),
      env,
      { fetchImpl }
    );
    expect(await listActiveSources(db)).toHaveLength(0);

    // /runonce queues a DB job instead of running heavy work in webhook
    await handleTelegramUpdate(makeMessageUpdate(23, 111222333, "/runonce"), env, { fetchImpl });
    const jobRow = await db
      .prepare(`SELECT * FROM jobs WHERE type = 'RUN_ONCE'`)
      .first<{ status: string; requested_by_chat_id: string }>();
    expect(jobRow?.status).toBe("PENDING");
    expect(jobRow?.requested_by_chat_id).toBe("111222333");
  });

  it("handles interactive Persian panel callbacks and audited manual retry for failed outbox", async () => {
    const { fetchImpl } = createMockTelegramFetch();

    await handleTelegramUpdate(makeCallbackUpdate(30, 111222333, "p:toggle_pause"), env, { fetchImpl });
    await handleTelegramUpdate(makeCallbackUpdate(31, 111222333, "p:toggle_lang"), env, { fetchImpl });
    await handleTelegramUpdate(makeCallbackUpdate(32, 111222333, "p:int:15"), env, { fetchImpl });
    await handleTelegramUpdate(makeCallbackUpdate(33, 111222333, "p:imp:80"), env, { fetchImpl });
    await handleTelegramUpdate(makeCallbackUpdate(34, 111222333, "p:ai_fb:queue"), env, { fetchImpl });
    await handleTelegramUpdate(makeCallbackUpdate(35, 111222333, "p:cat:0"), env, { fetchImpl });

    const settings = await getSettings(db);
    expect(settings.isPaused).toBe(true);
    expect(settings.language).toBe("en");
    expect(settings.checkIntervalMinutes).toBe(15);
    expect(settings.minImportanceScore).toBe(80);
    expect(settings.geminiFallbackBehavior).toBe("queue");
    expect(settings.enabledCategories).not.toContain("war_military");

    // Create a FAILED outbox entry and manually approve retry via panel callback
    const lease = (await acquireLease(db, "worker-1", 1_000, 90_000))!;
    const cluster = await createStoryCluster(
      db,
      lease,
      {
        primaryTitle: "Ambiguous send test",
        category: "nuclear",
        entities: [],
        locations: [],
        concepts: [],
        eventTime: 1_000,
        importanceScore: 90,
        credibilityScore: 90,
        confidenceScore: 80,
        urgency: "critical",
        verificationLabel: "corroborated",
      },
      1_000
    );
    const outbox = (await enqueueOutboxDelivery(
      db,
      lease,
      {
        clusterId: cluster.id,
        revisionNumber: 1,
        eventType: "INITIAL",
        updateReason: null,
        channelId: "@world_intel_ch",
        replyToMessageId: null,
        language: "fa",
        hasAiAnalysis: false,
        renderedHtml: "<b>Alert</b>",
      },
      1_000
    ))!;
    await claimOutboxForSending(db, lease, outbox.id, "tok-ambig-1", 2_000);
    await markOutboxFailed(db, outbox.id, "tok-ambig-1", "AMBIGUOUS_DELIVERY_STATE", "Timeout", 3_000);

    await handleTelegramUpdate(makeCallbackUpdate(36, 111222333, `p:retry:${outbox.id}`), env, {
      fetchImpl,
      now: 4_000,
    });

    const retried = await db
      .prepare(`SELECT status, previous_attempt_token, last_manual_retry_by FROM delivery_outbox WHERE id = ?`)
      .bind(outbox.id)
      .first<{ status: string; previous_attempt_token: string; last_manual_retry_by: string }>();
    expect(retried?.status).toBe("PENDING");
    expect(retried?.previous_attempt_token).toBe("tok-ambig-1");
    expect(retried?.last_manual_retry_by).toBe("111222333");

    const logs = await getRecentLogs(db, 3);
    expect(logs.some((l) => l.component === "outbox_manual_retry")).toBe(true);
  });

  it("supports /setchannel for a standard group (-987654321) when bot is a regular member and rejects restricted bots", async () => {
    const groupMock = createMockTelegramFetch({
      getChat: {
        ok: true,
        result: { id: -987654321, type: "group", title: "News Desk Group" },
      },
      getChatMember: {
        ok: true,
        result: { status: "member" },
      },
    });

    await handleTelegramUpdate(
      makeMessageUpdate(40, 111222333, "/setchannel -987654321"),
      env,
      { fetchImpl: groupMock.fetchImpl }
    );

    expect((await getSettings(db)).targetChannel).toBe("-987654321");
    expect(groupMock.calls.some((c) => c.method === "getChat")).toBe(true);
    const confirmationMsg = groupMock.calls.find((c) => c.method === "sendMessage");
    expect(String(confirmationMsg?.body.text)).toContain("گروه");

    // Restricted bot with can_send_messages: false must be rejected
    const restrictedGroupMock = createMockTelegramFetch({
      getChat: {
        ok: true,
        result: { id: -987654322, type: "group", title: "Read-only Group" },
      },
      getChatMember: {
        ok: true,
        result: { status: "restricted", can_send_messages: false },
      },
    });

    await handleTelegramUpdate(
      makeMessageUpdate(41, 111222333, "/setchannel -987654322"),
      env,
      { fetchImpl: restrictedGroupMock.fetchImpl }
    );
    expect((await getSettings(db)).targetChannel).toBe("-987654321");
  });

  it("responds to /chatid inside a group only for admins and ignores non-admins", async () => {
    const { fetchImpl, calls } = createMockTelegramFetch();

    const nonAdminGroupUpdate: TelegramUpdate = {
      update_id: 42,
      message: {
        message_id: 42,
        from: { id: 999888777, is_bot: false, first_name: "Stranger" },
        chat: { id: -987654321, type: "group", title: "News Desk Group" },
        date: 1700000000,
        text: "/chatid",
      },
    };
    await handleTelegramUpdate(nonAdminGroupUpdate, env, { fetchImpl });
    expect(calls).toHaveLength(0);

    const adminGroupUpdate: TelegramUpdate = {
      update_id: 43,
      message: {
        message_id: 43,
        from: { id: 111222333, is_bot: false, first_name: "Admin" },
        chat: { id: -987654321, type: "group", title: "News Desk Group" },
        date: 1700000001,
        text: "/chatid@GlobalNewsBot",
      },
    };
    await handleTelegramUpdate(adminGroupUpdate, env, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.body.chat_id).toBe(-987654321);
    expect(String(calls[0]?.body.text)).toContain("-987654321");
    expect(String(calls[0]?.body.text)).toContain("/setchannel -987654321");
  });
});