import { describe, expect, it } from "vitest";
import type { GeminiAnalysisOutput } from "../src/ai/gemini";
import {
  formatNewsPost,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../src/formatter";

const SAMPLE_AI_FA: GeminiAnalysisOutput = {
  localizedTitle: "کاهش نرخ بهره فدرال رزرو به میزان ۲۵ واحد پایه",
  summary: "فدرال رزرو نرخ بهره پایه را کاهش داد.",
  whatHappened: "کمیته سیاست پولی در نشست امروز تصمیم به کاهش ۰.۲۵ درصدی گرفت.",
  whyItMatters: "این تصمیم بر جریان سرمایه جهانی و نرخ ارز اثر می‌گذارد.",
  potentialConsequences: "ممکن است بازده اوراق خزانه کاهش یابد.",
  whatToWatch: "نشست خبری رئیس فدرال رزرو و واکنش بانک مرکزی اروپا.",
  uncertainOrUnconfirmed: "مسیر نرخ بهره در فصل آینده همچنان وابسته به داده‌های تورم است.",
};

describe("Phase 6 Telegram HTML Post Formatter (Persian & English)", () => {
  const eventTime = Date.parse("2026-11-19T12:00:00Z");
  const publishedAt = Date.parse("2026-11-19T12:15:00Z");

  it("formats a Persian post with AI analysis separating reported facts from AI assessment", () => {
    const html = formatNewsPost({
      language: "fa",
      eventType: "INITIAL",
      revisionNumber: 1,
      primaryTitle: "Federal Reserve cuts rates by 25 bps",
      fallbackSummary: null,
      category: "central_banks",
      urgency: "high",
      importanceScore: 82,
      credibilityScore: 90,
      confidenceScore: 86,
      independentSourceCount: 3,
      rawArticleCount: 4,
      verificationLabel: "corroborated",
      analysis: SAMPLE_AI_FA,
      sources: [
        { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/1" },
        { name: "CNBC", url: "https://cnbc.com/story/2" },
      ],
      eventTime,
      publishedAt,
    });

    expect(html).toContain("گزارش منابع (واقعیت‌های منتشرشده)");
    expect(html).toContain("تحلیل هوش مصنوعی (جدا از گزارش منابع)");
    expect(html).toContain("توسط 3 منبع مستقل");
    expect(html).toContain('<a href="https://feeds.bbci.co.uk/news/1">BBC Business</a>');
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
  });

  it("formats a clean fallback post without AI and highlights single_source verification warning", () => {
    const html = formatNewsPost({
      language: "fa",
      eventType: "INITIAL",
      revisionNumber: 1,
      primaryTitle: "Drone strike reported near <oil> terminal & port",
      fallbackSummary: "Initial reports indicate fire at storage tank.",
      category: "missile_drone",
      urgency: "critical",
      importanceScore: 88,
      credibilityScore: 82,
      confidenceScore: 54,
      independentSourceCount: 1,
      rawArticleCount: 1,
      verificationLabel: "single_source",
      analysis: null,
      sources: [{ name: "BBC World", url: "https://bbc.co.uk/news/world-1" }],
      eventTime,
      publishedAt,
    });

    expect(html).toContain("تک‌منبعی — نیازمند تأیید مستقل");
    expect(html).toContain("منتشرشده بدون تحلیل هوش مصنوعی");
    expect(html).toContain("&lt;oil&gt; terminal &amp; port");
    expect(html).not.toContain("<oil>");
  });

  it("formats English UPDATE posts with revision banner and update reason", () => {
    const html = formatNewsPost({
      language: "en",
      eventType: "UPDATE",
      revisionNumber: 2,
      updateReason: "Independently corroborated by 3 distinct sources",
      primaryTitle: "Magnitude 7.2 earthquake strikes coastal region",
      fallbackSummary: "Authorities issued a tsunami alert.",
      category: "natural_disasters",
      urgency: "critical",
      importanceScore: 91,
      credibilityScore: 92,
      confidenceScore: 88,
      independentSourceCount: 3,
      rawArticleCount: 5,
      verificationLabel: "corroborated",
      analysis: null,
      sources: [{ name: "NPR", url: "https://npr.org/quake-1" }],
      eventTime,
      publishedAt,
    });

    expect(html).toContain("UPDATE #2");
    expect(html).toContain("Independently corroborated by 3 distinct sources");
    expect(html).toContain("Corroborated by 3 independent sources");
    expect(html).toContain("Published without AI analysis");
  });

  it("enforces Telegram 4096-character ceiling even on oversized AI text while preserving source links", () => {
    const huge = "متن بسیار طولانی برای تست محدودیت طول پیام تلگرام. ".repeat(80);
    const html = formatNewsPost({
      language: "fa",
      eventType: "INITIAL",
      revisionNumber: 1,
      primaryTitle: "Test oversized post",
      fallbackSummary: huge,
      category: "geopolitics_diplomacy",
      urgency: "high",
      importanceScore: 80,
      credibilityScore: 85,
      confidenceScore: 80,
      independentSourceCount: 2,
      rawArticleCount: 2,
      verificationLabel: "corroborated",
      analysis: {
        localizedTitle: "تیتر تست",
        summary: huge,
        whatHappened: huge,
        whyItMatters: huge,
        potentialConsequences: huge,
        whatToWatch: huge,
        uncertainOrUnconfirmed: huge,
      },
      sources: [{ name: "Important Source", url: "https://important.example.com/article" }],
      eventTime,
      publishedAt,
    });

    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(html).toContain("https://important.example.com/article");
  });
});