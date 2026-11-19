const TEXT_ENCODER = new TextEncoder();

export function verifyWebhookSecret(
  providedSecret: string | null | undefined,
  expectedSecret: string | null | undefined
): boolean {
  if (!providedSecret || !expectedSecret) {
    return false;
  }

  const a = TEXT_ENCODER.encode(providedSecret);
  const b = TEXT_ENCODER.encode(expectedSecret);
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let i = 0; i < maxLen; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return diff === 0 && b.length > 0;
}

export function parseAdminUserIds(raw: string | null | undefined): Set<string> {
  const result = new Set<string>();
  if (!raw) return result;

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^\d{5,20}$/.test(trimmed)) {
      result.add(trimmed);
    }
  }
  return result;
}

export function isAdminUser(
  userId: number | string | null | undefined,
  adminUserIdsRaw: string | null | undefined
): boolean {
  if (userId === null || userId === undefined) return false;
  const normalized = String(userId).trim();
  if (!/^\d{5,20}$/.test(normalized)) return false;
  return parseAdminUserIds(adminUserIdsRaw).has(normalized);
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
  ".localdomain",
];

function isIpOrNumericHost(hostname: string): boolean {
  // IPv6 bracketed literal or raw colon form
  if (hostname.startsWith("[") || hostname.includes(":")) {
    return true;
  }
  // Standard dotted IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return true;
  }
  // Integer / hex / octal single-label IP representations (e.g. 2130706433, 0x7f000001)
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(hostname)) {
    return true;
  }
  return false;
}

export function validateFeedUrl(rawUrl: string): ValidationResult<string> {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return { ok: false, reason: "طول آدرس منبع خبری نامعتبر است (حداکثر ۵۱۲ کاراکتر)." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "فرمت آدرس URL معتبر نیست." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "فقط آدرس‌های امن با پروتکل https:// مجاز هستند." };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "وجود نام کاربری یا رمز عبور در URL مجاز نیست." };
  }

  if (parsed.port !== "" && parsed.port !== "443") {
    return { ok: false, reason: "استفاده از پورت‌های غیراستاندارد مجاز نیست." };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost") {
    return { ok: false, reason: "آدرس‌های محلی و داخلی مجاز نیستند." };
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "دامنه‌های شبکه داخلی مجاز نیستند." };
  }

  if (isIpOrNumericHost(host)) {
    return { ok: false, reason: "استفاده از آدرس IP مستقیم مجاز نیست؛ از دامنه رسمی استفاده کنید." };
  }

  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (labels.length < 2 || !/^[a-z]{2,24}$/.test(tld)) {
    return { ok: false, reason: "نام دامنه منبع خبری معتبر نیست." };
  }

  parsed.hash = "";
  return { ok: true, value: parsed.toString() };
}

export function derivePublisherGroup(validHttpsUrl: string): string {
  const parsed = new URL(validHttpsUrl);
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^(www|feeds|rss|news|api|m)\./, "");
  return host.slice(0, 64);
}

export function validateChannelTarget(raw: string): ValidationResult<string> {
  const trimmed = raw.trim();
  if (/^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(trimmed)) {
    return { ok: true, value: trimmed };
  }
  if (/^-100\d{5,20}$/.test(trimmed)) {
    return { ok: true, value: trimmed };
  }
  return {
    ok: false,
    reason:
      "فرمت کانال نامعتبر است. برای کانال عمومی از @username (حداقل ۵ کاراکتر) و برای کانال خصوصی از شناسه عددی با پیشوند -100 استفاده کنید.",
  };
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}