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
  channelId?: string | null;
}

const CATEGORY_LABELS_EN: Record<NewsCategory, string> = {
  war_military: "War & Military",
  missile_drone: "Missile & Drone",
  geopolitics_diplomacy: "Geopolitics",
  terrorism_security: "Security & Terror",
  nuclear: "Nuclear",
  cyber_infrastructure: "Cyber & Infrastructure",
  sanctions_policy: "Sanctions & Policy",
  energy_oil_gas: "Energy & Oil",
  economy_finance: "Economy & Finance",
  central_banks: "Central Banks",
  natural_disasters: "Natural Disasters",
  public_health: "Public Health",
  elections_governance: "Elections & Governance",
};

const URGENCY_ICON: Record<UrgencyLevel, string> = {
  critical: "🔴",
  high: "🟠",
  normal: "🟡",
  low: "⚪",
};

const URGENCY_TEXT_FA: Record<UrgencyLevel, string> = {
  critical: "فوری / بحرانی",
  high: "بالا",
  normal: "متوسط",
  low: "عادی",
};

const URGENCY_TEXT_EN: Record<UrgencyLevel, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  normal: "NORMAL",
  low: "LOW",
};

function toHashtag(label: string): string {
  const normalized = label
    .replace(/[،,&/]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
  return `#${normalized}`;
}

function cleanSourceDisplayName(rawName: string): string {
  const cleaned = rawName
    .replace(
      /\s*[-–—|]\s*(?:All News|Top Stories|Global Perspective|Latest News|Breaking News)$/i,
      ""
    )
    .trim();
  return (cleaned || rawName).slice(0, 48);
}

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

function formatCompactTimestamps(
  eventTime: number,
  publishedAt: number,
  language: PublishLanguage
): string {
  const reportedDate = new Date(eventTime);
  const publishedDate = new Date(publishedAt);
  if (Number.isNaN(reportedDate.getTime()) || Number.isNaN(publishedDate.getTime())) {
    return language === "fa" ? "🕒 زمان: —" : "🕒 Time: —";
  }

  try {
    if (language === "fa") {
      const dateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const timeFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        timeZone: "Asia/Tehran",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const repDateStr = dateFmt.format(reportedDate);
      const pubDateStr = dateFmt.format(publishedDate);
      const repTimeStr = timeFmt.format(reportedDate);
      const pubTimeStr = timeFmt.format(publishedDate);

      if (repDateStr === pubDateStr) {
        return `🕒 گزارش ${repDateStr}، ${repTimeStr}  •  انتشار ${pubTimeStr} تهران`;
      }
      return `🕒 گزارش ${repDateStr}، ${repTimeStr}  •  انتشار ${pubDateStr}، ${pubTimeStr} تهران`;
    }

    const dateFmtEn = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
    });
    const timeFmtEn = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const repDateStr = dateFmtEn.format(reportedDate);
    const pubDateStr = dateFmtEn.format(publishedDate);
    const repTimeStr = timeFmtEn.format(reportedDate);
    const pubTimeStr = timeFmtEn.format(publishedDate);

    if (repDateStr === pubDateStr) {
      return `🕒 Reported ${repDateStr}, ${repTimeStr}  •  Published ${pubTimeStr} UTC`;
    }
    return `🕒 Reported ${repDateStr}, ${repTimeStr}  •  Published ${pubDateStr}, ${pubTimeStr} UTC`;
  } catch {
    const repIso = reportedDate.toISOString().slice(11, 16);
    const pubIso = publishedDate.toISOString().slice(11, 16);
    return `🕒 ${repIso} / ${pubIso} UTC`;
  }
}

function renderVerificationLine(
  label: VerificationLabel,
  independentCount: number,
  language: PublishLanguage
): string {
  if (language === "fa") {
    if (label === "unverified") {
      return "⚠️ <i>تأییدنشده — نیازمند احتیاط و تأیید مستقل</i>";
    }
    if (label === "single_source") {
      return "⚠️ <i>تک‌منبعی — نیازمند تأیید مستقل</i>";
    }
    return `✅ <i>تأییدشده توسط ${independentCount} منبع مستقل</i>`;
  }

  if (label === "unverified") {
    return "⚠️ <i>UNVERIFIED — Requires independent confirmation</i>";
  }
  if (label === "single_source") {
    return "⚠️ <i>SINGLE SOURCE — Requires independent confirmation</i>";
  }
  return `✅ <i>Corroborated by ${independentCount} independent sources</i>`;
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

  const prefix = language === "fa" ? "🔗 <b>منبع:</b>" : "🔗 <b>Source:</b>";
  if (uniqueLinks.length === 0) {
    return `${prefix} —`;
  }

  const renderedLinks = uniqueLinks
    .map((src) => {
      const safeHref = sanitizeHref(src.url);
      const safeName = escapeHtml(cleanSourceDisplayName(src.name));
      return safeHref ? `<a href="${safeHref}">${safeName}</a>` : safeName;
    })
    .join("  •  ");

  return `${prefix} ${renderedLinks}`;
}

function truncatePlain(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, maxChars);
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

function isNearDuplicateText(a: string, b: string): boolean {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return true;

  let overlap = 0;
  for (const w of setA) {
    if (setB.has(w)) overlap++;
  }
  const ratio = overlap / Math.min(setA.size, setB.size);
  return ratio >= 0.6;
}

export function formatNewsPost(input: FormatNewsPostInput): string {
  const isFa = input.language === "fa";

  const titleText = truncatePlain(
    input.analysis?.localizedTitle || input.primaryTitle,
    220
  );
  const categoryLabel = isFa
    ? CATEGORY_LABELS_FA[input.category]
    : CATEGORY_LABELS_EN[input.category];
  const urgencyIcon = URGENCY_ICON[input.urgency];
  const urgencyText = isFa
    ? URGENCY_TEXT_FA[input.urgency]
    : URGENCY_TEXT_EN[input.urgency];

  const headerLines: string[] = [];
  if (input.eventType === "UPDATE") {
    const revBanner = isFa
      ? `🔄 <b>به‌روزرسانی #${input.revisionNumber}</b>`
      : `🔄 <b>UPDATE #${input.revisionNumber}</b>`;
    headerLines.push(
      input.updateReason
        ? `${revBanner}  —  <i>${escapeHtml(truncatePlain(input.updateReason, 150))}</i>`
        : revBanner
    );
  }

  headerLines.push(`${urgencyIcon} <b>${escapeHtml(titleText)}</b>`);
  headerLines.push(
    isFa
      ? `${escapeHtml(toHashtag(categoryLabel))}  •  فوریت: ${escapeHtml(urgencyText)}`
      : `${escapeHtml(toHashtag(categoryLabel))}  •  Urgency: ${escapeHtml(urgencyText)}`
  );
  headerLines.push(
    renderVerificationLine(
      input.verificationLabel,
      input.independentSourceCount,
      input.language
    )
  );

  const footerLines: string[] = [
    renderSourcesSection(input.sources, input.language),
    isFa
      ? `📊 اهمیت <b>${input.importanceScore}</b>  •  اعتبار <b>${input.credibilityScore}</b>  •  اطمینان <b>${input.confidenceScore}</b> (${input.independentSourceCount} منبع مستقل)`
      : `📊 Importance <b>${input.importanceScore}</b>  •  Credibility <b>${input.credibilityScore}</b>  •  Confidence <b>${input.confidenceScore}</b> (${input.independentSourceCount} independent)`,
    escapeHtml(
      formatCompactTimestamps(input.eventTime, input.publishedAt, input.language)
    ),
  ];

  const trimmedChannelId = input.channelId?.trim();
  const channelSignature = trimmedChannelId
    ? `\n\n${escapeHtml(trimmedChannelId)}`
    : "";

  const headerBlock = headerLines.join("\n");
  const footerBlock = `${footerLines.join("\n")}${channelSignature}`;

  const renderBody = (maxFieldChars: number): string => {
    if (input.analysis) {
      const a = input.analysis;
      const summaryClean = truncatePlain(a.summary, maxFieldChars);
      const whatHappenedClean = truncatePlain(a.whatHappened, maxFieldChars);

      // Avoid repeating the same sentence twice when summary and whatHappened say the same thing
      const factSection = isNearDuplicateText(summaryClean, whatHappenedClean)
        ? escapeHtml(
            whatHappenedClean.length >= summaryClean.length
              ? whatHappenedClean
              : summaryClean
          )
        : `${escapeHtml(summaryClean)}\n\n${escapeHtml(whatHappenedClean)}`;

      if (isFa) {
        const aiQuote = [
          "🤖 <b>تحلیل هوش مصنوعی</b>",
          `<b>• اهمیت:</b> ${escapeHtml(truncatePlain(a.whyItMatters, maxFieldChars))}`,
          `<b>• پیامدها:</b> ${escapeHtml(truncatePlain(a.potentialConsequences, maxFieldChars))}`,
          `<b>• پیگیری:</b> ${escapeHtml(truncatePlain(a.whatToWatch, maxFieldChars))}`,
          `<b>• نکات نامشخص:</b> ${escapeHtml(truncatePlain(a.uncertainOrUnconfirmed, maxFieldChars))}`,
        ].join("\n");

        return `${factSection}\n\n<blockquote>${aiQuote}</blockquote>`;
      }

      const aiQuoteEn = [
        "🤖 <b>AI Assessment</b>",
        `<b>• Why it matters:</b> ${escapeHtml(truncatePlain(a.whyItMatters, maxFieldChars))}`,
        `<b>• Implications:</b> ${escapeHtml(truncatePlain(a.potentialConsequences, maxFieldChars))}`,
        `<b>• What to watch:</b> ${escapeHtml(truncatePlain(a.whatToWatch, maxFieldChars))}`,
        `<b>• Unconfirmed:</b> ${escapeHtml(truncatePlain(a.uncertainOrUnconfirmed, maxFieldChars))}`,
      ].join("\n");

      return `${factSection}\n\n<blockquote>${aiQuoteEn}</blockquote>`;
    }

    // Clean fallback template without AI analysis
    const rawSummary = input.fallbackSummary
      ? truncatePlain(input.fallbackSummary, maxFieldChars * 2)
      : isFa
        ? "جزئیات تکمیلی در فید منبع درج نشده است؛ متن کامل را از لینک زیر بخوانید."
        : "No additional summary provided in feed; read full details via the source link below.";

    if (isFa) {
      return `${escapeHtml(rawSummary)}\n\n<i>(منتشرشده بدون تحلیل هوش مصنوعی)</i>`;
    }
    return `${escapeHtml(rawSummary)}\n\n<i>(Published without AI analysis)</i>`;
  };

  // Progressive field budget reduction guarantees <= 4096 chars without breaking HTML tags or losing links/channel ID
  for (const fieldBudget of [550, 380, 250, 160, 90]) {
    const assembled = `${headerBlock}\n\n${renderBody(fieldBudget)}\n\n${footerBlock}`;
    if (assembled.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      return assembled;
    }
  }

  const minimal = `${headerBlock}\n\n${footerBlock}`;
  return minimal.length <= TELEGRAM_MAX_MESSAGE_LENGTH
    ? minimal
    : `${minimal.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1)}…`;
}