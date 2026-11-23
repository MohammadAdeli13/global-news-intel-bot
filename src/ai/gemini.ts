import type {
  AnalysisLength,
  NewsCategory,
  PublishLanguage,
  VerificationLabel,
} from "../types";

export interface GeminiHttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type GeminiFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<GeminiHttpResponseLike>;

export interface GeminiAnalysisOutput {
  localizedTitle: string;
  summary: string;
  whatHappened: string;
  whyItMatters: string;
  potentialConsequences: string;
  whatToWatch: string;
  uncertainOrUnconfirmed: string;
}

export interface GeminiArticleEvidence {
  sourceName: string;
  title: string;
  summary: string | null;
  publishedAtIso: string;
}

export interface GeminiAnalyzeRequest {
  apiKey: string;
  primaryModel: string;
  fallbackModel?: string;
  emergencyModel?: string;
  language: PublishLanguage;
  analysisLength: AnalysisLength;
  category: NewsCategory;
  verificationLabel: VerificationLabel;
  independentSourceCount: number;
  isUpdate: boolean;
  updateReason?: string | null;
  articles: readonly GeminiArticleEvidence[];
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: GeminiFetchLike;
}

export type GeminiAnalyzeResult =
  | {
      ok: true;
      modelUsed: string;
      analysis: GeminiAnalysisOutput;
      attempts: number;
    }
  | {
      ok: false;
      code:
        | "RATE_LIMITED"
        | "DAILY_CAP_REACHED"
        | "COOLDOWN_ACTIVE"
        | "API_ERROR"
        | "INVALID_OUTPUT"
        | "NETWORK_ERROR";
      retryAfterSeconds?: number;
      detail: string;
      modelErrors: string[];
      attempts: number;
    };

export const GEMINI_TIMEOUT_MS = 20_000;
export const GEMINI_503_RETRY_DELAY_MS = 2_000;
export const GEMINI_DEFAULT_COOLDOWN_SECONDS = 300; // 5 minutes after 429

const RUNTIME_AI_COOLDOWN_KEY = "_runtime_ai_cooldown_until";
const RUNTIME_AI_USAGE_KEY = "_runtime_ai_daily_usage";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    localizedTitle: {
      type: "STRING",
      description: "Concise, factual headline in the requested target language.",
    },
    summary: {
      type: "STRING",
      description: "Brief factual summary strictly grounded in provided sources.",
    },
    whatHappened: {
      type: "STRING",
      description: "Strictly reported facts only: who, what, where, when from sources.",
    },
    whyItMatters: {
      type: "STRING",
      description: "Analytical explanation of why this development is significant.",
    },
    potentialConsequences: {
      type: "STRING",
      description: "Plausible near-term implications clearly framed as analytical assessment.",
    },
    whatToWatch: {
      type: "STRING",
      description: "Specific upcoming developments, statements, or indicators to monitor.",
    },
    uncertainOrUnconfirmed: {
      type: "STRING",
      description: "Facts that remain unconfirmed, disputed, single-sourced, or absent from current reports.",
    },
  },
  required: [
    "localizedTitle",
    "summary",
    "whatHappened",
    "whyItMatters",
    "potentialConsequences",
    "whatToWatch",
    "uncertainOrUnconfirmed",
  ],
} as const;

export function buildGeminiPrompts(req: GeminiAnalyzeRequest): {
  systemInstruction: string;
  userPrompt: string;
} {
  const targetLang = req.language === "fa" ? "Persian (Farsi)" : "English";
  const lengthGuidance: Record<AnalysisLength, string> = {
    short: "Keep each field crisp: 1 to 2 short sentences (max 35 words per field).",
    medium: "Keep each field clear and concise: 2 to 3 sentences (max 55 words per field).",
    detailed: "Provide thorough but focused bullets/sentences: 3 to 4 sentences (max 85 words per field).",
  };

  const systemInstruction = [
      "You are a senior geopolitical, security, and macroeconomic newsroom editor writing crisp Telegram intelligence briefs.",
      `Respond ONLY in ${targetLang} using valid JSON matching the required schema.`,
      req.language === "fa"
        ? "Write natural, polished journalistic Persian with proper half-spaces (نیم‌فاصله, e.g. می‌شود، نشان‌دهنده، کشته‌شده). Avoid stiff word-for-word translation."
        : "Write sharp, wire-style journalistic English.",
      "STRICT ANTI-HALLUCINATION & NON-REPETITION RULES:",
      "1. Base 'localizedTitle', 'summary', and 'whatHappened' EXCLUSIVELY on facts explicitly stated in the provided source items.",
      "2. NEVER invent casualties, numbers, dates, locations, official statements, weapons types, or causes not present in the sources.",
      "3. Keep 'summary' as a crisp 1-sentence news lead. In 'whatHappened', provide distinct concrete context/details from the sources WITHOUT repeating 'summary' verbatim.",
      "4. Keep reported facts strictly separate from AI analysis ('whyItMatters', 'potentialConsequences', 'whatToWatch'). Use cautious analytical phrasing ('may', 'could', 'احتمالاً', 'ممکن است') for projections.",
      "5. In 'uncertainOrUnconfirmed', identify specific factual gaps (e.g., official response, exact toll, attribution, timing) instead of only repeating that the report is single-sourced.",
      "6. Do not claim independent verification beyond what is given in the metadata.",
      lengthGuidance[req.analysisLength],
    ].join("\n");

  const evidenceLines = req.articles.slice(0, 6).map((a, idx) => {
    const summaryPart = a.summary ? `Summary: ${a.summary}` : "Summary: (not provided in feed)";
    return [
      `[Source ${idx + 1}] ${a.sourceName} (${a.publishedAtIso})`,
      `Headline: ${a.title}`,
      summaryPart,
    ].join("\n");
  });

  const verificationNote =
    req.verificationLabel === "corroborated"
      ? `Corroborated by ${req.independentSourceCount} independent sources.`
      : req.verificationLabel === "single_source"
        ? "Single independent source only (requires independent confirmation)."
        : "Unverified / low-certainty report (explicitly highlight uncertainty).";

  const updateLine = req.isUpdate
    ? `Publication Type: UPDATE revision (${req.updateReason ?? "new developments"}). Focus on what changed and current status.`
    : "Publication Type: INITIAL report.";

  const userPrompt = [
    `Category: ${req.category}`,
    `Verification Status: ${verificationNote}`,
    updateLine,
    "",
    "SOURCE REPORTS:",
    ...evidenceLines,
    "",
    "Based ONLY on the preceding source reports, produce the structured JSON analysis.",
  ].join("\n");

  return { systemInstruction, userPrompt };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCleanErrorMessage(rawText: string): string {
  const compact = rawText.replace(/\s+/g, " ").trim();
  if (!compact) return "empty response";

  try {
    const parsed = JSON.parse(rawText) as {
      error?: { message?: unknown; status?: unknown };
    };
    const status =
      typeof parsed?.error?.status === "string"
        ? parsed.error.status.replace(/\s+/g, " ").trim()
        : "";
    const msg =
      typeof parsed?.error?.message === "string"
        ? parsed.error.message.replace(/\s+/g, " ").trim()
        : "";

    if (status && msg) return `${status}: ${msg}`.slice(0, 90);
    if (msg) return msg.slice(0, 90);
    if (status) return status.slice(0, 60);
  } catch {
    // Response is plain text rather than JSON
  }

  return compact.slice(0, 90);
}

type SingleModelFailure = {
  ok: false;
  code: "RATE_LIMITED" | "API_ERROR" | "INVALID_OUTPUT" | "NETWORK_ERROR";
  httpStatus?: number;
  retryAfterSeconds?: number;
  summary: string;
  detail: string;
};

export async function analyzeClusterWithGemini(
  req: GeminiAnalyzeRequest
): Promise<GeminiAnalyzeResult> {
  if (!req.apiKey.trim()) {
    return {
      ok: false,
      code: "API_ERROR",
      detail: "Missing GEMINI_API_KEY",
      modelErrors: ["Missing GEMINI_API_KEY"],
      attempts: 0,
    };
  }

  if (req.articles.length === 0) {
    return {
      ok: false,
      code: "INVALID_OUTPUT",
      detail: "No source articles provided for analysis",
      modelErrors: ["No source articles provided"],
      attempts: 0,
    };
  }

  const candidateModels = [
    req.primaryModel.trim(),
    req.fallbackModel?.trim() ?? "",
    req.emergencyModel?.trim() ?? "",
  ];
  const modelsToTry: string[] = [];
  for (const model of candidateModels) {
    if (model && !modelsToTry.includes(model)) {
      modelsToTry.push(model);
    }
  }

  const emergencySlug = req.emergencyModel?.trim() || "";
  const retryDelayMs = req.retryDelayMs ?? GEMINI_503_RETRY_DELAY_MS;
  const maxOutputTokens =
    req.analysisLength === "detailed"
      ? 1200
      : req.analysisLength === "medium"
        ? 900
        : 650;

  const prompts = buildGeminiPrompts(req);
  let attempts = 0;
  const modelErrors: string[] = [];
  let allRateLimited = true;
  let maxRetryAfterSeconds: number | undefined;
  let lastFailure: SingleModelFailure | null = null;

  for (const model of modelsToTry) {
    const isEmergencyModel =
      Boolean(emergencySlug) && model === emergencySlug && modelsToTry.length > 1;
    // Allow 1 short retry on HTTP 503 for primary/fallback models; skip retry on emergency model to protect its small daily quota
    const max503Retries = isEmergencyModel ? 0 : 1;

    let result:
      | { ok: true; analysis: GeminiAnalysisOutput }
      | SingleModelFailure;
    let retriesUsed = 0;

    while (true) {
      attempts++;
      result = await callSingleGeminiModel({
        apiKey: req.apiKey,
        model,
        systemInstruction: prompts.systemInstruction,
        userPrompt: prompts.userPrompt,
        maxOutputTokens,
        timeoutMs: req.timeoutMs ?? GEMINI_TIMEOUT_MS,
        fetchImpl: req.fetchImpl,
      });

      if (result.ok) {
        return {
          ok: true,
          modelUsed: model,
          analysis: result.analysis,
          attempts,
        };
      }

      if (result.httpStatus === 503 && retriesUsed < max503Retries) {
        retriesUsed++;
        await sleep(retryDelayMs);
        continue;
      }

      break;
    }

    const retryNote = retriesUsed > 0 ? ` (after ${retriesUsed} retry)` : "";
    modelErrors.push(`${model}: ${result.summary}${retryNote}`);
    lastFailure = result;

    if (result.code !== "RATE_LIMITED") {
      allRateLimited = false;
    } else if (typeof result.retryAfterSeconds === "number") {
      maxRetryAfterSeconds = Math.max(
        maxRetryAfterSeconds ?? 0,
        result.retryAfterSeconds
      );
    }

    // Fail over to next model on transient/quota/API errors
    const shouldTryNextModel =
      result.code === "RATE_LIMITED" ||
      result.code === "NETWORK_ERROR" ||
      result.code === "API_ERROR";

    if (!shouldTryNextModel) {
      break;
    }
  }

  const finalCode =
    allRateLimited && modelErrors.length > 0
      ? "RATE_LIMITED"
      : lastFailure?.code ?? "API_ERROR";

  return {
    ok: false,
    code: finalCode,
    retryAfterSeconds:
      finalCode === "RATE_LIMITED"
        ? maxRetryAfterSeconds ?? GEMINI_DEFAULT_COOLDOWN_SECONDS
        : undefined,
    detail: modelErrors.join(" | ") || "No Gemini model attempted",
    modelErrors,
    attempts,
  };
}

async function callSingleGeminiModel(params: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userPrompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  fetchImpl?: GeminiFetchLike;
}): Promise<{ ok: true; analysis: GeminiAnalysisOutput } | SingleModelFailure> {
  const fetchImpl: GeminiFetchLike =
    params.fetchImpl ?? ((url, init) => fetch(url, init));

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent`;

  // Per official Gemini 3.5+ documentation, deprecated sampling params (temperature, topP, topK) are omitted
  const body = {
    systemInstruction: {
      parts: [{ text: params.systemInstruction }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: params.userPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: params.maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": params.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();

    if (response.status === 429) {
      const retryHeader = response.headers?.get("retry-after");
      const parsedRetry = retryHeader ? Number(retryHeader) : NaN;
      const retryAfterSeconds =
        Number.isFinite(parsedRetry) && parsedRetry > 0
          ? Math.min(Math.ceil(parsedRetry), 3600)
          : GEMINI_DEFAULT_COOLDOWN_SECONDS;

      const cleanMsg = extractCleanErrorMessage(rawText);
      return {
        ok: false,
        code: "RATE_LIMITED",
        httpStatus: 429,
        retryAfterSeconds,
        summary: `HTTP 429 (${cleanMsg})`,
        detail: `Gemini HTTP 429 on ${params.model}: ${cleanMsg}`,
      };
    }

    if (!response.ok) {
      const cleanMsg = extractCleanErrorMessage(rawText);
      return {
        ok: false,
        code: "API_ERROR",
        httpStatus: response.status,
        summary: `HTTP ${response.status} (${cleanMsg})`,
        detail: `Gemini HTTP ${response.status} on ${params.model}: ${cleanMsg}`,
      };
    }

    const parsed = parseGeminiApiEnvelope(rawText);
    if (!parsed.ok) {
      return {
        ok: false,
        code: "INVALID_OUTPUT",
        httpStatus: response.status,
        summary: `INVALID_OUTPUT (${parsed.detail})`,
        detail: parsed.detail,
      };
    }

    return { ok: true, analysis: parsed.analysis };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.replace(/\s+/g, " ").trim()
        : String(error);
    return {
      ok: false,
      code: "NETWORK_ERROR",
      summary: `TIMEOUT/NET (${message.slice(0, 70)})`,
      detail: `Gemini network/timeout error on ${params.model}: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiCandidatePart {
  text?: unknown;
  thought?: unknown;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiCandidatePart[];
    };
    finishReason?: string;
  }>;
}

export function parseGeminiApiEnvelope(
  rawText: string
):
  | { ok: true; analysis: GeminiAnalysisOutput }
  | { ok: false; detail: string } {
  let envelope: GeminiGenerateContentResponse;
  try {
    envelope = JSON.parse(rawText) as GeminiGenerateContentResponse;
  } catch {
    return { ok: false, detail: "Gemini HTTP 200 returned non-JSON envelope" };
  }

  const parts = envelope.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const reason = envelope.candidates?.[0]?.finishReason ?? "empty_candidates";
    return { ok: false, detail: `Gemini returned no content parts (${reason})` };
  }

  // Skip internal thought parts if present and collect final text output
  const textContent = parts
    .filter((p) => p.thought !== true && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();

  if (!textContent) {
    return { ok: false, detail: "Gemini content text was empty" };
  }

  const cleanedJson = stripMarkdownCodeFence(textContent);

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(cleanedJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, detail: "Gemini JSON payload is not an object" };
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, detail: "Gemini output text is not valid JSON" };
  }

  const requiredKeys: (keyof GeminiAnalysisOutput)[] = [
    "localizedTitle",
    "summary",
    "whatHappened",
    "whyItMatters",
    "potentialConsequences",
    "whatToWatch",
    "uncertainOrUnconfirmed",
  ];

  const output: Partial<GeminiAnalysisOutput> = {};
  for (const key of requiredKeys) {
    const val = obj[key];
    if (typeof val !== "string" || val.trim().length === 0) {
      return { ok: false, detail: `Gemini JSON missing or empty field: ${key}` };
    }
    output[key] = val.replace(/\s+/g, " ").trim();
  }

  return {
    ok: true,
    analysis: output as GeminiAnalysisOutput,
  };
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    const lastFence = trimmed.lastIndexOf("```");
    if (firstNewline !== -1 && lastFence > firstNewline) {
      return trimmed.slice(firstNewline + 1, lastFence).trim();
    }
  }
  return trimmed;
}

// ============================================================================
// D1-backed Daily Soft Cap & Cooldown Helpers (Zero Schema Changes)
// ============================================================================

interface DailyUsageState {
  utcDate: string;
  count: number;
}

function getUtcDateString(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export async function checkGeminiQuotaAndCooldown(
  db: D1Database,
  dailyLimit: number,
  now: number = Date.now()
): Promise<
  | { allowed: true; usedToday: number }
  | { allowed: false; code: "COOLDOWN_ACTIVE" | "DAILY_CAP_REACHED"; detail: string }
> {
  const [cooldownRow, usageRow] = await db.batch<{ value_json: string }>([
    db
      .prepare(`SELECT value_json FROM settings WHERE key = ?`)
      .bind(RUNTIME_AI_COOLDOWN_KEY),
    db
      .prepare(`SELECT value_json FROM settings WHERE key = ?`)
      .bind(RUNTIME_AI_USAGE_KEY),
  ]);

  const cooldownRaw = cooldownRow?.results[0]?.value_json;
  if (cooldownRaw) {
    try {
      const cooldownUntil = Number(JSON.parse(cooldownRaw));
      if (Number.isFinite(cooldownUntil) && cooldownUntil > now) {
        const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
        return {
          allowed: false,
          code: "COOLDOWN_ACTIVE",
          detail: `Gemini cooldown active for ${remainingSec}s`,
        };
      }
    } catch {
      // Ignore malformed state
    }
  }

  const today = getUtcDateString(now);
  let usedToday = 0;
  const usageRaw = usageRow?.results[0]?.value_json;
  if (usageRaw) {
    try {
      const parsed = JSON.parse(usageRaw) as DailyUsageState;
      if (parsed.utcDate === today && Number.isFinite(parsed.count)) {
        usedToday = parsed.count;
      }
    } catch {
      // Ignore malformed state
    }
  }

  if (usedToday >= dailyLimit) {
    return {
      allowed: false,
      code: "DAILY_CAP_REACHED",
      detail: `Gemini soft daily cap reached (${usedToday}/${dailyLimit})`,
    };
  }

  return { allowed: true, usedToday };
}

export async function recordGeminiUsage(
  db: D1Database,
  incrementBy: number = 1,
  now: number = Date.now()
): Promise<number> {
  const today = getUtcDateString(now);
  const existing = await db
    .prepare(`SELECT value_json FROM settings WHERE key = ?`)
    .bind(RUNTIME_AI_USAGE_KEY)
    .first<{ value_json: string }>();

  let nextCount = incrementBy;
  if (existing?.value_json) {
    try {
      const parsed = JSON.parse(existing.value_json) as DailyUsageState;
      if (parsed.utcDate === today && Number.isFinite(parsed.count)) {
        nextCount = parsed.count + incrementBy;
      }
    } catch {
      // Reset on parse failure
    }
  }

  const nextState: DailyUsageState = { utcDate: today, count: nextCount };
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .bind(RUNTIME_AI_USAGE_KEY, JSON.stringify(nextState), now)
    .run();

  return nextCount;
}

export async function setGeminiCooldown(
  db: D1Database,
  cooldownSeconds: number,
  now: number = Date.now()
): Promise<number> {
  const cooldownUntil = now + Math.max(30, cooldownSeconds) * 1000;
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .bind(RUNTIME_AI_COOLDOWN_KEY, JSON.stringify(cooldownUntil), now)
    .run();
  return cooldownUntil;
}