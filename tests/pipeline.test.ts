import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeminiAnalysisOutput, GeminiFetchLike } from "../src/ai/gemini";
import {
  enqueueJob,
  getClusterPublicationEvents,
  seedDefaultSettings,
  setSetting,
  upsertSource,
} from "../src/database";
import type { Env } from "../src/env";
import type { FeedFetchLike } from "../src/feeds/rss";
import { runScheduledPipeline } from "../src/news";
import type { FetchLike } from "../src/telegram";
import { createTestD1 } from "./helpers/sqlite-d1";

const MOCK_AI_FA: GeminiAnalysisOutput = {
  localizedTitle: "حمله موشکی به تاسیسات بندری و خسارت به مخازن سوخت",
  summary: "منابع خبری از اصابت چند موشک بالستیک به بندر خبر دادند.",
  whatHappened: "بر اساس گزارش منابع، چند موشک به بخش انرژی بندر اصابت کرده است.",
  whyItMatters: "این بندر در مسیر صادرات انرژی منطقه نقش کلیدی دارد.",
  potentialConsequences: "احتمال نوسان کوتاه‌مدت در بازار انرژی وجود دارد.",
  whatToWatch: "بیانیه رسمی نهادهای دفاعی و ارزیابی خسارت.",
  uncertainOrUnconfirmed: "آمار نهایی تلفات هنوز به تأیید مستقل نرسیده است.",
};

function makeRssXml(items: Array<{ title: string; link: string; desc: string; pubDate: string }>): string {
  const body = items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link><description>${i.desc}</description><pubDate>${i.pubDate}</pubDate></item>`
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title>${body}</channel></rss>`;
}

function makeFeedMock(feedByUrl: Record<string, string>): FeedFetchLike {
  return async (url) => {
    const xml = feedByUrl[url];
    if (!xml) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        async text() {
          return "Not Found";
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return xml;
      },
    };
  };
}

function makeGeminiOkMock(): GeminiFetchLike {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(MOCK_AI_FA) }] },
            finishReason: "STOP",
          },
        ],
      });
    },
  });
}

describe("Phase 7 End-to-End Scheduled Pipeline Integration", () => {
  let db: D1Database;
  let closeDb: () => void;
  let env: Env;
  let currentTime: number;

  beforeEach(async () => {
    const testDb = await createTestD1();
    db = testDb.db;
    closeDb = testDb.close;
    currentTime = Date.parse("2026-11-19T12:00:00Z");
    env = {
      DB: db,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_WEBHOOK_SECRET: "test-secret",
      ADMIN_USER_IDS: "111222333",
      GEMINI_API_KEY: "test-gemini-key",
      ENVIRONMENT: "test",
    };
    await seedDefaultSettings(db, currentTime);
    await setSetting(db, "targetChannel", "@world_intel_test", currentTime);
  });

  afterEach(() => {
    closeDb();
  });

  it("runs full pipeline (RSS -> 5D Cluster -> Score -> Gemini -> Outbox -> Telegram) and sends UPDATE #2 on independent corroboration", async () => {
    const urlA = "https://source-a.example.com/rss.xml";
    const urlB = "https://source-b.example.com/rss.xml";

    await upsertSource(db, {
      name: "BBC World",
      url: urlA,
      type: "rss",
      publisherGroup: "bbc",
      credibilityTier: 1,
      baseCredibility: 88,
    });
    await upsertSource(db, {
      name: "NPR World",
      url: urlB,
      type: "rss",
      publisherGroup: "npr",
      credibilityTier: 1,
      baseCredibility: 86,
    });

    // Tick 1: only Source A reports the missile strike (single_source)
    let feedMap: Record<string, string> = {
      [urlA]: makeRssXml([
        {
          title: "Breaking: Ballistic missile strike hits port energy facility in Kyiv, dozens killed",
          link: "https://source-a.example.com/kyiv-strike",
          desc: "Emergency crews responded after multiple ballistic missiles hit fuel depots in Kyiv.",
          pubDate: "Thu, 19 Nov 2026 11:45:00 GMT",
        },
      ]),
      [urlB]: makeRssXml([]),
    };

    const sentTelegramCalls: Array<Record<string, unknown>> = [];
    let nextMessageId = 500;
    const telegramMock: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      sentTelegramCalls.push(body);
      const msgId = nextMessageId++;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: msgId } };
        },
        async text() {
          return JSON.stringify({ ok: true, result: { message_id: msgId } });
        },
      };
    };

    const run1 = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock(feedMap),
      fetchGemini: makeGeminiOkMock(),
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(run1.feedsChecked).toBe(2);
    expect(run1.articlesIngested).toBe(1);
    expect(run1.geminiCalls).toBe(1);
    expect(run1.postsSent).toBe(1);
    expect(String(sentTelegramCalls[0]?.text)).toContain("تک‌منبعی — نیازمند تأیید مستقل");
    expect(String(sentTelegramCalls[0]?.text)).toContain("تحلیل هوش مصنوعی");

    // Advance 45 minutes past update cooldown; independent Source B corroborates the exact same event
    currentTime += 45 * 60 * 1000;
    feedMap = {
      [urlA]: feedMap[urlA]!,
      [urlB]: makeRssXml([
        {
          title: "Russian ballistic missile airstrike damages energy port in Kyiv, officials confirm casualties",
          link: "https://source-b.example.com/kyiv-corroboration",
          desc: "Defense ministry confirmed casualties following the overnight missile strike in Kyiv.",
          pubDate: "Thu, 19 Nov 2026 12:30:00 GMT",
        },
      ]),
    };

    const run2 = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock(feedMap),
      fetchGemini: makeGeminiOkMock(),
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(run2.articlesIngested).toBe(1);
    expect(run2.clustersUpdated).toBe(1);
    expect(run2.postsSent).toBe(1);
    expect(sentTelegramCalls).toHaveLength(2);
    expect(String(sentTelegramCalls[1]?.text)).toContain("به‌روزرسانی #2");
    expect(sentTelegramCalls[1]?.reply_parameters).toEqual({
      message_id: 500,
      allow_sending_without_reply: true,
    });

    const events = await getClusterPublicationEvents(db, 1);
    expect(events).toHaveLength(2);
    expect(events[0]?.event_type).toBe("INITIAL");
    expect(events[1]?.event_type).toBe("UPDATE");
    expect(events[1]?.parent_telegram_message_id).toBe(500);
  });

  it("handles Gemini 429 cleanly under both fallback policies (publish_without_ai and queue)", async () => {
    const urlA = "https://source-a.example.com/rss.xml";
    await upsertSource(db, {
      name: "BBC World",
      url: urlA,
      type: "rss",
      publisherGroup: "bbc",
      credibilityTier: 1,
      baseCredibility: 88,
    });

    const gemini429: GeminiFetchLike = async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "300" },
      async text() {
        return "Quota exceeded";
      },
    });

    const telegramMessages: string[] = [];
    const telegramMock: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { text: string };
      telegramMessages.push(body.text);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 800 } };
        },
        async text() {
          return "";
        },
      };
    };

    // Policy 1: publish_without_ai -> publishes clean fallback post even when Gemini returns 429
    await setSetting(db, "geminiFallbackBehavior", "publish_without_ai", currentTime);
    const runFallback = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({
        [urlA]: makeRssXml([
          {
            title: "Magnitude 7.6 earthquake triggers tsunami warning across Pacific coast",
            link: "https://source-a.example.com/quake-1",
            desc: "Authorities ordered immediate coastal evacuations after the major quake.",
            pubDate: "Thu, 19 Nov 2026 11:50:00 GMT",
          },
        ]),
      }),
      fetchGemini: gemini429,
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(runFallback.postsSent).toBe(1);
    expect(telegramMessages[0]).toContain("منتشرشده بدون تحلیل هوش مصنوعی");

    // Policy 2: queue -> holds new eligible story in QUEUED without publishing during cooldown
    currentTime += 10 * 60 * 1000;
    await setSetting(db, "geminiFallbackBehavior", "queue", currentTime);
    const runQueued = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({
        [urlA]: makeRssXml([
          {
            title: "Federal Reserve announces emergency 75 bps interest rate cut amid banking crisis",
            link: "https://source-a.example.com/fed-cut",
            desc: "Central bank acted to prevent systemic liquidity failure.",
            pubDate: "Thu, 19 Nov 2026 12:05:00 GMT",
          },
        ]),
      }),
      fetchGemini: gemini429,
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(runQueued.postsSent).toBe(0);
    expect(runQueued.outboxEnqueued).toBe(0);
  });

  it("marks ambiguous Telegram timeout as FAILED, alerts admin with manual retry button, and NEVER auto-retries", async () => {
    const urlA = "https://source-a.example.com/rss.xml";
    await upsertSource(db, {
      name: "BBC World",
      url: urlA,
      type: "rss",
      publisherGroup: "bbc",
      credibilityTier: 1,
      baseCredibility: 88,
    });
    await setSetting(db, "geminiEnabled", false, currentTime);

    const adminAlerts: Array<Record<string, unknown>> = [];
    const telegramMock: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if (body.chat_id === "@world_intel_test") {
        throw new Error("AbortError: request timed out after dispatch");
      }
      adminAlerts.push(body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 901 } };
        },
        async text() {
          return "";
        },
      };
    };

    const run1 = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({
        [urlA]: makeRssXml([
          {
            title: "Breaking: Nuclear watchdog IAEA calls emergency session over uranium enrichment",
            link: "https://source-a.example.com/nuclear-1",
            desc: "Inspectors reported sudden enrichment jump.",
            pubDate: "Thu, 19 Nov 2026 11:55:00 GMT",
          },
        ]),
      }),
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(run1.postsSent).toBe(0);
    expect(run1.postsFailed).toBe(1);
    expect(adminAlerts).toHaveLength(1);
    expect(String(adminAlerts[0]?.text)).toContain("هشدار ارسال مبهم");

    // Next Cron tick must NOT auto-retry the ambiguous outbox entry
    currentTime += 6 * 60 * 1000;
    const run2 = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({ [urlA]: makeRssXml([]) }),
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(run2.postsSent).toBe(0);
    expect(run2.postsFailed).toBe(0);
    expect(adminAlerts).toHaveLength(1);
  });

  it("executes queued RUN_ONCE and TEST_FEEDS jobs via Cron and sends reports back to admin", async () => {
    const urlA = "https://source-a.example.com/rss.xml";
    await upsertSource(db, {
      name: "Test RSS",
      url: urlA,
      type: "rss",
      publisherGroup: "testrss",
      credibilityTier: 1,
      baseCredibility: 85,
    });

    const reports: string[] = [];
    const telegramMock: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { text: string };
      reports.push(body.text);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 950 } };
        },
        async text() {
          return "";
        },
      };
    };

    await enqueueJob(
      db,
      { type: "TEST_FEEDS", priority: 1, requestedByChatId: "111222333" },
      currentTime
    );

    const testRun = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({
        [urlA]: makeRssXml([
          {
            title: "Sample item",
            link: "https://source-a.example.com/1",
            desc: "Sample",
            pubDate: "Thu, 19 Nov 2026 11:00:00 GMT",
          },
        ]),
      }),
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(testRun.jobProcessed).toContain("TEST_FEEDS");
    expect(reports[0]).toContain("نتیجه تست منابع خبری");

    await enqueueJob(
      db,
      { type: "RUN_ONCE", priority: 1, requestedByChatId: "111222333" },
      currentTime + 1_000
    );

    const runOnce = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({ [urlA]: makeRssXml([]) }),
      fetchTelegram: telegramMock,
      now: () => currentTime + 2_000,
    });

    expect(runOnce.jobProcessed).toContain("RUN_ONCE");
    expect(reports[1]).toContain("گزارش اجرای فوری");
  });

  it("uses sendPhoto for short posts (<=1024 chars) and sendMessage with large top preview for long posts (>1024 chars)", async () => {
    const urlA = "https://source-media.example.com/rss.xml";
    const photoUrl = "https://cdn.example.com/photo.jpg";

    await upsertSource(db, {
      name: "BBC World",
      url: urlA,
      type: "rss",
      publisherGroup: "bbc",
      credibilityTier: 1,
      baseCredibility: 88,
    });
    await setSetting(db, "includeImages", true, currentTime);

    const recordedCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let msgSeq = 1200;
    const telegramMock: FetchLike = async (url, init) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      recordedCalls.push({ method, body });
      const messageId = msgSeq++;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: messageId } };
        },
        async text() {
          return JSON.stringify({ ok: true, result: { message_id: messageId } });
        },
      };
    };

    // Case 1: Short post (<= 1024 chars, without AI) -> MUST dispatch via sendPhoto
    await setSetting(db, "geminiEnabled", false, currentTime);
    const shortFeedXml = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <item>
          <title>Breaking: Ballistic missile strike hits port infrastructure, dozens killed</title>
          <link>https://source-media.example.com/short-story</link>
          <description>Emergency crews responded after missiles struck fuel depots.</description>
          <pubDate>Thu, 19 Nov 2026 11:50:00 GMT</pubDate>
          <media:content url="${photoUrl}" medium="image" />
        </item>
      </channel>
    </rss>`;

    const shortRun = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({ [urlA]: shortFeedXml }),
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(shortRun.postsSent).toBe(1);
    expect(recordedCalls[0]?.method).toBe("sendPhoto");
    expect(recordedCalls[0]?.body.photo).toBe(photoUrl);
    expect(String(recordedCalls[0]?.body.caption).length).toBeLessThanOrEqual(1024);

    // Case 2: Long post (> 1024 chars, with full AI analysis) -> MUST dispatch via sendMessage with large top preview
    currentTime += 10 * 60 * 1000;
    await setSetting(db, "geminiEnabled", true, currentTime);

    const longAiPayload: GeminiAnalysisOutput = {
      localizedTitle: "زمین‌لرزه ۷.۸ ریشتری و صدور هشدار سونامی در سواحل اقیانوس آرام",
      summary:
        "زمین‌لرزه‌ای شدید به بزرگی ۷.۸ ریشتر بامداد امروز مناطق ساحلی را لرزاند و باعث صدور فوری هشدار سونامی و تخلیه گسترده ساکنان مناطق کم‌ارتفاع در چند استان ساحلی شد.",
      whatHappened:
        "مراکز لرزه‌نگاری کانون این زمین‌لرزه را در عمق کم بستر دریا ثبت کردند و تیم‌های امداد و مدیریت بحران بلافاصله پس از قطع برق و آسیب به بنادر و جاده‌های ساحلی به حالت آماده‌باش کامل درآمدند.",
      whyItMatters:
        "شدت بالای لرزش در مجاورت بنادر تجاری و زیرساخت‌های حیاتی انرژی می‌تواند زنجیره تأمین دریایی و حمل‌ونقل منطقه‌ای را برای چند روز مختل کرده و خسارت اقتصادی قابل‌توجهی ایجاد کند.",
      potentialConsequences:
        "احتمال وقوع پس‌لرزه‌های قدرتمند، اختلال موقت در فعالیت کشتیرانی و افزایش هزینه‌های بیمه و لجستیک در بنادر آسیب‌دیده طی روزهای آینده وجود دارد.",
      whatToWatch:
        "گزارش رسمی مرکز هشدار سونامی درباره ارتفاع امواج، آمار دقیق خسارات زیرساختی بنادر، وضعیت شبکه‌های برق و مخابرات و اطلاعیه‌های امدادرسانی دولت.",
      uncertainOrUnconfirmed:
        "آمار نهایی تلفات جانی، میزان دقیق خسارت به تأسیسات بندری و زمان بازگشایی کامل مسیرهای دریایی هنوز به‌طور رسمی و مستقل تأیید نشده است.",
    };

    const longGeminiMock: GeminiFetchLike = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: JSON.stringify(longAiPayload) }] },
              finishReason: "STOP",
            },
          ],
        });
      },
    });

    const longFeedXml = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <item>
          <title>Magnitude 7.8 earthquake triggers tsunami warning across Pacific coastal ports</title>
          <link>https://source-media.example.com/long-quake-story</link>
          <description>Authorities ordered mass coastal evacuations after a major shallow earthquake struck offshore.</description>
          <pubDate>Thu, 19 Nov 2026 12:05:00 GMT</pubDate>
          <media:content url="${photoUrl}" medium="image" />
        </item>
      </channel>
    </rss>`;

    const longRun = await runScheduledPipeline(env, {
      fetchFeed: makeFeedMock({ [urlA]: longFeedXml }),
      fetchGemini: longGeminiMock,
      fetchTelegram: telegramMock,
      now: () => currentTime,
    });

    expect(longRun.postsSent).toBe(1);
    expect(recordedCalls[1]?.method).toBe("sendMessage");
    expect(String(recordedCalls[1]?.body.text).length).toBeGreaterThan(1024);
    expect(recordedCalls[1]?.body.link_preview_options).toEqual({
      is_disabled: false,
      url: photoUrl,
      prefer_large_media: true,
      show_above_text: true,
    });
  });
});