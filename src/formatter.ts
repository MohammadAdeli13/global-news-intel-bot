import { CATEGORY_LABELS_FA } from "./admin";
import type { GeminiAnalysisOutput } from "./ai/gemini";
import { escapeHtml } from "./security";
import type {
  NewsCategory,
  PublicationEventType,
  PublishLanguage,
  UrgencyLevel,
  VerificationLabel,
} from "./types";

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface FormatSourceLink {
  name: string;
  url: string;
}

export interface FormatNewsPostInput {
  language: PublishLanguage;
  eventType: PublicationEventType;
  revisionNumber: number;
  updateReason?: string | null;
  primaryTitle: string;
  fallbackSummary: string | null;
  category: NewsCategory;
  urgency: UrgencyLevel;
  importanceScore: number;
  credibilityScore: number;
  confidenceScore: number;
  independentSourceCount: number;
  rawArticleCount: number;
  verificationLabel: VerificationLabel;
  analysis: GeminiAnalysisOutput | null;
  sources: readonly FormatSourceLink[];
  eventTime: number;
  publishedAt: number;
}

const CATEGORY_LABELS_EN: Record<NewsCategory, string> = {
  war_military: "War & Military",
  missile_drone: "Missile & Drone Attacks",
  geopolitics_diplomacy: "Geopolitics & Diplomacy",
  terrorism_security: "Terrorism & Security",
  nuclear: "Nuclear Developments",
  cyber_infrastructure: "Cyber & Critical Infrastructure",
  sanctions_policy: "Sanctions & Policy",
  energy_oil_gas: "Oil, Gas & Energy",
  economy_finance: "Economy & Financial Crises",
  central_banks: "Central Banks",
  natural_disasters: "Natural Disasters",
  public_health: "Public Health",
  elections_governance: "Elections & Governance",
};

const URGENCY_LABELS_FA: Record<UrgencyLevel, string> = {
  critical: "🔴 بحرانی / فوری",
  high: "🟠 بالا",
  normal: "🟡 متوسط",
  low: "⚪ عادی",
};

const URGENCY_LABELS_EN: Record<UrgencyLevel, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  normal: "🟡 NORMAL",
  low: "⚪ LOW",
};

function sanitizeHref(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return escapeHtml(parsed.toString());
  } catch {
    return null;
  }
}

function formatTimestamp(ms: number, language: PublishLanguage): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  try {
    if (language === "fa") {
      const tehran = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
      const utcTime = date.toISOString().slice(11, 16);
      return `${tehran} تهران (${utcTime} UTC)`;
    }

    const utcStr = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    return `${utcStr} UTC`;
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

function renderVerificationBanner(
  label: VerificationLabel,
  independentCount: number,
  language: PublishLanguage
): string {
  if (language === "fa") {
    if (label === "unverified") {
      return "⚠️ <b>وضعیت تأیید: تأییدنشده — نیازمند احتیاط و تأیید مستقل</b>";
    }
    if (label === "single_source") {
      return "⚠️ <b>وضعیت تأیید: تک‌منبعی — نیازمند تأیید مستقل</b>";
    }
    return `✅ <b>وضعیت تأیید: گزارش‌شده توسط ${independentCount} منبع مستقل</b>`;
  }

  if (label === "unverified") {
    return "⚠️ <b>Verification: UNVERIFIED — Requires independent confirmation</b>";
  }
  if (label === "single_source") {
    return "⚠️ <b>Verification: SINGLE SOURCE — Requires independent confirmation</b>";
  }
  return `✅ <b>Verification: Corroborated by ${independentCount} independent sources</b>`;
}

function renderSourcesSection(
  sources: readonly FormatSourceLink[],
  language: PublishLanguage
): string {
  const uniqueLinks: FormatSourceLink[] = [];
  const seenUrls = new Set<string>();
  for (const src of sources) {
    if (uniqueLinks.length >= 5) break;
    if (seenUrls.has(src.url)) continue;
    seenUrls.add(src.url);
    uniqueLinks.push(src);
  }

  const header = language === "fa" ? "🔗 <b>منابع اصلی:</b>" : "🔗 <b>Sources:</b>";
  if (uniqueLinks.length === 0) {
    return language === "fa" ? `${header} —` : `${header} None`;
  }

  const renderedLinks = uniqueLinks
    .map((src) => {
      const safeHref = sanitizeHref(src.url);
      const safeName = escapeHtml(src.name.slice(0, 60));
      return safeHref ? `<a href="${safeHref}">${safeName}</a>` : safeName;
    })
    .join(" | ");

  return `${header} ${renderedLinks}`;
}

function truncatePlain(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, maxChars);
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

export function formatNewsPost(input: FormatNewsPostInput): string {
  const isFa = input.language === "fa";

  const titleText = truncatePlain(
    input.analysis?.localizedTitle || input.primaryTitle,
    240
  );
  const categoryLabel = isFa
    ? CATEGORY_LABELS_FA[input.category]
    : CATEGORY_LABELS_EN[input.category];
  const urgencyLabel = isFa
    ? URGENCY_LABELS_FA[input.urgency]
    : URGENCY_LABELS_EN[input.urgency];

  const headerLines: string[] = [];
  if (input.eventType === "UPDATE") {
    const revBanner = isFa
      ? `🔄 <b>به‌روزرسانی #${input.revisionNumber}</b>`
      : `🔄 <b>UPDATE #${input.revisionNumber}</b>`;
    headerLines.push(revBanner);
    if (input.updateReason) {
      headerLines.push(
        isFa
          ? `<i>دلیل به‌روزرسانی: ${escapeHtml(truncatePlain(input.updateReason, 180))}</i>`
          : `<i>Update trigger: ${escapeHtml(truncatePlain(input.updateReason, 180))}</i>`
      );
    }
  }

  headerLines.push(`<b>${escapeHtml(titleText)}</b>`);
  headerLines.push(
    isFa
      ? `🗂 <b>دسته:</b> ${escapeHtml(categoryLabel)} | ⚡ <b>فوریت:</b> ${urgencyLabel}`
      : `🗂 <b>Category:</b> ${escapeHtml(categoryLabel)} | ⚡ <b>Urgency:</b> ${urgencyLabel}`
  );
  headerLines.push(
    renderVerificationBanner(
      input.verificationLabel,
      input.independentSourceCount,
      input.language
    )
  );

  const footerLines: string[] = [
    isFa
      ? `📊 <b>شاخص‌ها:</b> اهمیت <b>${input.importanceScore}</b>/100 | اعتبار منبع <b>${input.credibilityScore}</b>/100 | اطمینان <b>${input.confidenceScore}</b>/100 (منابع مستقل: ${input.independentSourceCount})`
      : `📊 <b>Scores:</b> Importance <b>${input.importanceScore}</b>/100 | Credibility <b>${input.credibilityScore}</b>/100 | Confidence <b>${input.confidenceScore}</b>/100 (Independent sources: ${input.independentSourceCount})`,
    renderSourcesSection(input.sources, input.language),
    isFa
      ? `🕒 <b>زمان گزارش:</b> ${escapeHtml(formatTimestamp(input.eventTime, "fa"))}\n📤 <b>زمان انتشار:</b> ${escapeHtml(formatTimestamp(input.publishedAt, "fa"))}`
      : `🕒 <b>Reported:</b> ${escapeHtml(formatTimestamp(input.eventTime, "en"))}\n📤 <b>Published:</b> ${escapeHtml(formatTimestamp(input.publishedAt, "en"))}`,
  ];

  const headerBlock = headerLines.join("\n");
  const footerBlock = footerLines.join("\n");

  const renderBody = (maxFieldChars: number): string => {
    if (input.analysis) {
      const a = input.analysis;
      if (isFa) {
        return [
          "📰 <b>گزارش منابع (واقعیت‌های منتشرشده):</b>",
          `• <b>خلاصه خبر:</b> ${escapeHtml(truncatePlain(a.summary, maxFieldChars))}`,
          `• <b>چه اتفاقی افتاده:</b> ${escapeHtml(truncatePlain(a.whatHappened, maxFieldChars))}`,
          "",
          "🤖 <b>تحلیل هوش مصنوعی (جدا از گزارش منابع):</b>",
          `• <b>چرا مهم است:</b> ${escapeHtml(truncatePlain(a.whyItMatters, maxFieldChars))}`,
          `• <b>پیامدهای احتمالی:</b> ${escapeHtml(truncatePlain(a.potentialConsequences, maxFieldChars))}`,
          `• <b>چه تحولاتی را دنبال کنیم:</b> ${escapeHtml(truncatePlain(a.whatToWatch, maxFieldChars))}`,
          `• <b>موارد نامشخص / تأییدنشده:</b> ${escapeHtml(truncatePlain(a.uncertainOrUnconfirmed, maxFieldChars))}`,
        ].join("\n");
      }

      return [
        "📰 <b>Reported Facts (From Sources):</b>",
        `• <b>Summary:</b> ${escapeHtml(truncatePlain(a.summary, maxFieldChars))}`,
        `• <b>What happened:</b> ${escapeHtml(truncatePlain(a.whatHappened, maxFieldChars))}`,
        "",
        "🤖 <b>AI Assessment (Separate from Source Reporting):</b>",
        `• <b>Why it matters:</b> ${escapeHtml(truncatePlain(a.whyItMatters, maxFieldChars))}`,
        `• <b>Potential implications:</b> ${escapeHtml(truncatePlain(a.potentialConsequences, maxFieldChars))}`,
        `• <b>What to watch:</b> ${escapeHtml(truncatePlain(a.whatToWatch, maxFieldChars))}`,
        `• <b>Uncertain / Unconfirmed:</b> ${escapeHtml(truncatePlain(a.uncertainOrUnconfirmed, maxFieldChars))}`,
      ].join("\n");
    }

    // Fallback template without AI analysis
    const rawSummary = input.fallbackSummary
      ? truncatePlain(input.fallbackSummary, maxFieldChars * 2)
      : isFa
        ? "خلاصه تکمیلی در فید منبع موجود نبود؛ جزئیات کامل را از لینک منابع زیر مطالعه کنید."
        : "No additional summary provided in feed; see linked original sources below.";

    if (isFa) {
      return [
        "📰 <b>خلاصه گزارش منبع:</b>",
        escapeHtml(rawSummary),
        "<i>(منتشرشده بدون تحلیل هوش مصنوعی)</i>",
      ].join("\n");
    }

    return [
      "📰 <b>Source Summary:</b>",
      escapeHtml(rawSummary),
      "<i>(Published without AI analysis)</i>",
    ].join("\n");
  };

  // Progressive field budget reduction guarantees <= 4096 chars without breaking HTML tags or losing links
  for (const fieldBudget of [600, 400, 260, 160, 90]) {
    const assembled = `${headerBlock}\n\n${renderBody(fieldBudget)}\n\n${footerBlock}`;
    if (assembled.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      return assembled;
    }
  }

  // Extreme fallback if sources/header themselves were unusually large
  const minimal = `${headerBlock}\n\n${footerBlock}`;
  return minimal.length <= TELEGRAM_MAX_MESSAGE_LENGTH
    ? minimal
    : `${minimal.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1)}…`;
}