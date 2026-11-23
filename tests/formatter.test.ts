import { describe, expect, it } from "vitest";
import type { GeminiAnalysisOutput } from "../src/ai/gemini";
import {
  formatNewsPost,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../src/formatter";

const SAMPLE_AI_FA: GeminiAnalysisOutput = {
  localizedTitle: "کاهش نرخ بهره فدرال رزرو به میزان ۲۵ واحد پایه",
  summary: "فدرال رزرو نرخ بهره پایه آمریکا را ۰.۲۵ درصد کاهش داد.",
  whatHappened: "کمیته بازار آزاد در پایان نشست دو روزه خود با اکثریت آرا این تصمیم را تصویب کرد و از کاهش تدریجی فشار تورمی خبر داد.",
  whyItMatters: "این تصمیم بر جریان سرمایه جهانی و نرخ ارز اثر می‌گذارد.",
  potentialConsequences: "ممکن است بازده اوراق خزانه کاهش یابد.",
  whatToWatch: "نشست خبری رئیس فدرال رزرو و واکنش بانک مرکزی اروپا.",
  uncertainOrUnconfirmed: "مسیر نرخ بهره در فصل آینده همچنان وابسته به داده‌های تورم است.",
};

describe("Phase 6 Telegram HTML Post Formatter (Persian & English)", () => {
  const eventTime = Date.parse("2026-11-19T12:00:00Z");
  const publishedAt = Date.parse("2026-11-19T12:15:00Z");

  it("formats a sleek Persian post with blockquote AI analysis, hashtag, clean source name, and channel ID at the end", () => {
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
        { name: "Al Jazeera - All News", url: "https://aljazeera.com/news/1" },
        { name: "CNBC", url: "https://cnbc.com/story/2" },
      ],
      eventTime,
      publishedAt,
      channelId: "@world_intel_fa",
    });

    expect(html).toContain("🟠 <b>کاهش نرخ بهره فدرال رزرو به میزان ۲۵ واحد پایه</b>");
    expect(html).toContain("#بانک‌های_مرکزی");
    expect(html).toContain("<blockquote>🤖 <b>تحلیل هوش مصنوعی</b>");
    expect(html).toContain("توسط 3 منبع مستقل");
    expect(html).toContain('<a href="https://aljazeera.com/news/1">Al Jazeera</a>');
    expect(html).not.toContain("All News");
    expect(html.trimEnd().endsWith("@world_intel_fa")).toBe(true);
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
  });

  it("deduplicates near-identical summary and whatHappened instead of repeating the same sentence twice", () => {
    const html = formatNewsPost({
      language: "fa",
      eventType: "INITIAL",
      revisionNumber: 1,
      primaryTitle: "UNRWA worker killed in airstrike",
      fallbackSummary: null,
      category: "missile_drone",
      urgency: "high",
      importanceScore: 77,
      credibilityScore: 78,
      confidenceScore: 56,
      independentSourceCount: 1,
      rawArticleCount: 1,
      verificationLabel: "single_source",
      analysis: {
        localizedTitle: "غزه در سوگ کارمند کشته‌شده آنروا",
        summary: "عادل الحلو کارمند آنروا در حمله هوایی اسرائیل در غزه کشته شد.",
        whatHappened: "عادل الحلو کارمند آژانس آنروا روز دوشنبه در حمله هوایی اسرائیل در غزه کشته شد.",
        whyItMatters: "خطرات مستمر برای نیروهای امدادی را برجسته می‌کند.",
        potentialConsequences: "ممکن است فشار بین‌المللی افزایش یابد.",
        whatToWatch: "بیانیه رسمی سازمان ملل و آنروا.",
        uncertainOrUnconfirmed: "جزئیات دقیق محل حمله هنوز تأیید نشده است.",
      },
      sources: [{ name: "Al Jazeera - All News", url: "https://aljazeera.com/2" }],
      eventTime,
      publishedAt,
      channelId: "@world_intel_fa",
    });

    const occurrences = html.split("عادل الحلو").length - 1;
    expect(occurrences).toBe(1);
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
      channelId: "@world_intel_fa",
    });

    expect(html).toContain("تک‌منبعی — نیازمند تأیید مستقل");
    expect(html).toContain("منتشرشده بدون تحلیل هوش مصنوعی");
    expect(html).toContain("&lt;oil&gt; terminal &amp; port");
    expect(html).not.toContain("<oil>");
    expect(html.trimEnd().endsWith("@world_intel_fa")).toBe(true);
  });

  it("formats English UPDATE posts with revision banner, update reason, and channel ID", () => {
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
      channelId: "@global_intel_en",
    });

    expect(html).toContain("UPDATE #2");
    expect(html).toContain("Independently corroborated by 3 distinct sources");
    expect(html).toContain("Corroborated by 3 independent sources");
    expect(html).toContain("Published without AI analysis");
    expect(html.trimEnd().endsWith("@global_intel_en")).toBe(true);
  });

  it("enforces Telegram 4096-character ceiling even on oversized AI text while preserving source links and channel ID", () => {
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
      channelId: "@world_intel_fa",
    });

    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(html).toContain("https://important.example.com/article");
    expect(html.trimEnd().endsWith("@world_intel_fa")).toBe(true);
  });
});