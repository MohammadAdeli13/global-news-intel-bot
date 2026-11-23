import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeClusterWithGemini,
  checkGeminiQuotaAndCooldown,
  parseGeminiApiEnvelope,
  recordGeminiUsage,
  setGeminiCooldown,
  type GeminiAnalysisOutput,
  type GeminiFetchLike,
} from "../src/ai/gemini";
import { createTestD1 } from "./helpers/sqlite-d1";

const VALID_ANALYSIS_FA: GeminiAnalysisOutput = {
  localizedTitle: "حمله موشکی به زیرساخت بندری و واکنش پدافند هوایی",
  summary: "منابع خبری از اصابت چند موشک به تاسیسات بندری خبر دادند.",
  whatHappened: "بر اساس گزارش منابع، چند موشک به بخش سوخت بندر اصابت کرده است.",
  whyItMatters: "این بندر یکی از مسیرهای کلیدی انتقال انرژی در منطقه محسوب می‌شود.",
  potentialConsequences: "احتمال افزایش کوتاه‌مدت بهای انرژی و تشدید تنش‌های منطقه‌ای وجود دارد.",
  whatToWatch: "بیانیه رسمی وزارت دفاع و گزارش شرکت‌های کشتیرانی درباره میزان خسارت.",
  uncertainOrUnconfirmed: "آمار دقیق تلفات و منشأ شلیک هنوز به‌طور مستقل تأیید نشده است.",
};

function wrapGeminiResponse(payload: unknown): string {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              text:
                typeof payload === "string" ? payload : JSON.stringify(payload),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  });
}

describe("Phase 6 Gemini API Client, Anti-Hallucination & Quota Guard", () => {
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

  it("parses valid structured JSON and markdown-fenced JSON, and rejects incomplete JSON", () => {
    const ok = parseGeminiApiEnvelope(wrapGeminiResponse(VALID_ANALYSIS_FA));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.analysis.localizedTitle).toBe(VALID_ANALYSIS_FA.localizedTitle);
    }

    const fenced = parseGeminiApiEnvelope(
      wrapGeminiResponse("```json\n" + JSON.stringify(VALID_ANALYSIS_FA) + "\n```")
    );
    expect(fenced.ok).toBe(true);

    const missingField = parseGeminiApiEnvelope(
      wrapGeminiResponse({ ...VALID_ANALYSIS_FA, whatToWatch: "" })
    );
    expect(missingField.ok).toBe(false);

    const brokenJson = parseGeminiApiEnvelope(wrapGeminiResponse("{broken json"));
    expect(brokenJson.ok).toBe(false);
  });

  it("sends API key in x-goog-api-key header (not URL) and switches to fallback model on 429", async () => {
    const calledUrls: string[] = [];
    const calledHeaders: Array<Record<string, string> | undefined> = [];

    const mockFetch: GeminiFetchLike = async (url, init) => {
      calledUrls.push(url);
      calledHeaders.push(init?.headers);

      if (url.includes("gemini-3.5-flash-lite")) {
        return {
          ok: false,
          status: 429,
          headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "60" : null) },
          async text() {
            return JSON.stringify({ error: { message: "Quota exceeded" } });
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return wrapGeminiResponse(VALID_ANALYSIS_FA);
        },
      };
    };

    const result = await analyzeClusterWithGemini({
      apiKey: "secret-key-xyz",
      primaryModel: "gemini-3.5-flash-lite",
      fallbackModel: "gemini-3.1-flash-lite",
      language: "fa",
      analysisLength: "short",
      category: "missile_drone",
      verificationLabel: "single_source",
      independentSourceCount: 1,
      isUpdate: false,
      articles: [
        {
          sourceName: "BBC World",
          title: "Missile strike hits port facility",
          summary: "Officials reported damage at fuel depot.",
          publishedAtIso: "2026-11-19T12:00:00Z",
        },
      ],
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelUsed).toBe("gemini-3.1-flash-lite");
      expect(result.attempts).toBe(2);
    }

    // Security check: API key must never appear in request URL
    expect(calledUrls.every((u) => !u.includes("secret-key-xyz"))).toBe(true);
    expect(calledHeaders[0]?.["x-goog-api-key"]).toBe("secret-key-xyz");
  });

  it("returns structured RATE_LIMITED error when both primary and fallback models hit 429", async () => {
    const mockFetch: GeminiFetchLike = async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "180" },
      async text() {
        return "Too Many Requests";
      },
    });

    const result = await analyzeClusterWithGemini({
      apiKey: "secret-key-xyz",
      primaryModel: "gemini-3.5-flash-lite",
      fallbackModel: "gemini-3.1-flash-lite",
      language: "fa",
      analysisLength: "short",
      category: "nuclear",
      verificationLabel: "corroborated",
      independentSourceCount: 3,
      isUpdate: false,
      articles: [
        {
          sourceName: "Reuters",
          title: "IAEA emergency statement",
          summary: null,
          publishedAtIso: "2026-11-19T12:00:00Z",
        },
      ],
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RATE_LIMITED");
      expect(result.retryAfterSeconds).toBe(180);
      expect(result.attempts).toBe(2);
    }
  });

  it("handles network timeouts without throwing", async () => {
    const mockFetch: GeminiFetchLike = async () => {
      throw new Error("AbortError: request timed out");
    };

    const result = await analyzeClusterWithGemini({
      apiKey: "secret-key-xyz",
      primaryModel: "gemini-3.5-flash-lite",
      language: "en",
      analysisLength: "medium",
      category: "energy_oil_gas",
      verificationLabel: "corroborated",
      independentSourceCount: 2,
      isUpdate: false,
      articles: [
        {
          sourceName: "CNBC",
          title: "Oil surges 5%",
          summary: "Supply disruption fears.",
          publishedAtIso: "2026-11-19T12:00:00Z",
        },
      ],
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NETWORK_ERROR");
    }
  });

  it("enforces D1-backed cooldown and UTC daily soft cap", async () => {
    const day1 = Date.parse("2026-11-19T10:00:00Z");

    expect(await checkGeminiQuotaAndCooldown(db, 2, day1)).toEqual({
      allowed: true,
      usedToday: 0,
    });

    await recordGeminiUsage(db, 1, day1);
    await recordGeminiUsage(db, 1, day1 + 1_000);

    const capped = await checkGeminiQuotaAndCooldown(db, 2, day1 + 2_000);
    expect(capped.allowed).toBe(false);
    if (!capped.allowed) {
      expect(capped.code).toBe("DAILY_CAP_REACHED");
    }

    // Next UTC day resets usage counter automatically
    const day2 = Date.parse("2026-11-20T00:05:00Z");
    expect(await checkGeminiQuotaAndCooldown(db, 2, day2)).toEqual({
      allowed: true,
      usedToday: 0,
    });

    // Cooldown blocks until expiry
    await setGeminiCooldown(db, 120, day2);
    const cooling = await checkGeminiQuotaAndCooldown(db, 2, day2 + 30_000);
    expect(cooling.allowed).toBe(false);
    if (!cooling.allowed) {
      expect(cooling.code).toBe("COOLDOWN_ACTIVE");
    }

    const afterCooldown = await checkGeminiQuotaAndCooldown(db, 2, day2 + 130_000);
    expect(afterCooldown.allowed).toBe(true);
  });
  it("omits deprecated temperature param and retries once on HTTP 503 before succeeding", async () => {
    let calls = 0;
    let sentBody = "";

    const mockFetch: GeminiFetchLike = async (_url, init) => {
      calls++;
      sentBody = init?.body ?? "";
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          async text() {
            return JSON.stringify({
              error: {
                code: 503,
                status: "UNAVAILABLE",
                message: "This model is currently experiencing high demand.",
              },
            });
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return wrapGeminiResponse(VALID_ANALYSIS_FA);
        },
      };
    };

    const result = await analyzeClusterWithGemini({
      apiKey: "secret-key-xyz",
      primaryModel: "gemini-3.5-flash-lite",
      fallbackModel: "gemini-3.1-flash-lite",
      emergencyModel: "gemini-3.6-flash",
      language: "fa",
      analysisLength: "short",
      category: "missile_drone",
      verificationLabel: "corroborated",
      independentSourceCount: 2,
      isUpdate: false,
      retryDelayMs: 0,
      articles: [
        {
          sourceName: "BBC World",
          title: "Port strike update",
          summary: "Officials confirmed damage.",
          publishedAtIso: "2026-11-19T12:00:00Z",
        },
      ],
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelUsed).toBe("gemini-3.5-flash-lite");
      expect(result.attempts).toBe(2);
    }

    const parsedBody = JSON.parse(sentBody) as {
      generationConfig?: Record<string, unknown>;
    };
    expect(parsedBody.generationConfig).toBeDefined();
    expect("temperature" in (parsedBody.generationConfig ?? {})).toBe(false);
  });

  it("falls through to 3rd emergency model (gemini-3.6-flash) when both Flash-Lite models return 503", async () => {
    const calledModels: string[] = [];

    const mockFetch: GeminiFetchLike = async (url) => {
      calledModels.push(url);
      if (url.includes("gemini-3.6-flash")) {
        return {
          ok: true,
          status: 200,
          async text() {
            return wrapGeminiResponse(VALID_ANALYSIS_FA);
          },
        };
      }
      return {
        ok: false,
        status: 503,
        async text() {
          return JSON.stringify({
            error: { status: "UNAVAILABLE", message: "High demand" },
          });
        },
      };
    };

    const result = await analyzeClusterWithGemini({
      apiKey: "secret-key-xyz",
      primaryModel: "gemini-3.5-flash-lite",
      fallbackModel: "gemini-3.1-flash-lite",
      emergencyModel: "gemini-3.6-flash",
      language: "fa",
      analysisLength: "short",
      category: "nuclear",
      verificationLabel: "corroborated",
      independentSourceCount: 3,
      isUpdate: false,
      retryDelayMs: 0,
      articles: [
        {
          sourceName: "Reuters",
          title: "IAEA statement",
          summary: "Inspectors issued alert.",
          publishedAtIso: "2026-11-19T12:00:00Z",
        },
      ],
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelUsed).toBe("gemini-3.6-flash");
      // 2 calls on 3.5 (1 + 1 retry) + 2 calls on 3.1 (1 + 1 retry) + 1 call on 3.6 = 5
      expect(result.attempts).toBe(5);
    }
    expect(calledModels.some((u) => u.includes("gemini-3.6-flash"))).toBe(true);
  });

  it("logs clean single-line per-model error summaries without raw JSON braces when all models fail", async () => {
    const mockFetch: GeminiFetchLike = async (url) => {
      if (url.includes("gemini-3.5-flash-lite")) {
        return {
          ok: false,
          status: 503,
          async text() {
            return '{\n  "error": {\n    "code": 503,\n    "status": "UNAVAILABLE",\n    "message": "Model overloaded"\n  }\n}';
          },
        };
      }
      if (url.includes("gemini-3.1-flash-lite")) {
        throw new Error("AbortError: timeout");
      }
      return {
        ok: false,
        status: 429,
        async text() {
          return JSON.stringify({
            error: { status: "RESOURCE_EXHAUSTED", message: "Quota limit reached" },
          });
        },
      };
    };

    const result = await analyzeClusterWithGemini({
      apiKey: "secret-key-xyz",
      primaryModel: "gemini-3.5-flash-lite",
      fallbackModel: "gemini-3.1-flash-lite",
      emergencyModel: "gemini-3.6-flash",
      language: "fa",
      analysisLength: "short",
      category: "energy_oil_gas",
      verificationLabel: "single_source",
      independentSourceCount: 1,
      isUpdate: false,
      retryDelayMs: 0,
      articles: [
        {
          sourceName: "CNBC",
          title: "Oil surge",
          summary: "Supply shock.",
          publishedAtIso: "2026-11-19T12:00:00Z",
        },
      ],
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.modelErrors).toHaveLength(3);
      expect(result.detail).toContain("gemini-3.5-flash-lite: HTTP 503 (UNAVAILABLE: Model overloaded) (after 1 retry)");
      expect(result.detail).toContain("gemini-3.1-flash-lite: TIMEOUT/NET");
      expect(result.detail).toContain("gemini-3.6-flash: HTTP 429 (RESOURCE_EXHAUSTED: Quota limit reached)");
      expect(result.detail).not.toContain("{");
      expect(result.detail).not.toContain("\n");
    }
  });
});