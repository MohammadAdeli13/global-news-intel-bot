import {
  FEED_USER_AGENT,
  type FeedFetchLike,
  type RawFeedItem,
} from "./rss";

export const GDELT_TIMEOUT_MS = 5_000;
export const GDELT_DEFAULT_MAX_RECORDS = 15;

const GDELT_DEFAULT_QUERY =
  '(missile OR airstrike OR sanctions OR nuclear OR "central bank" OR "oil price" OR cyberattack OR earthquake OR ceasefire) sourcelang:english';

interface GdeltArticlePayload {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
}

interface GdeltDocResponse {
  articles?: unknown;
}

export interface GdeltItem extends RawFeedItem {
  domain: string;
}

export type GdeltFetchResult =
  | { ok: true; items: GdeltItem[] }
  | { ok: false; error: string };

export async function fetchGdeltArticles(params?: {
  query?: string;
  timespan?: string;
  maxRecords?: number;
  timeoutMs?: number;
  now?: number;
  fetchImpl?: FeedFetchLike;
}): Promise<GdeltFetchResult> {
  const now = params?.now ?? Date.now();
  const maxRecords = Math.min(
    Math.max(params?.maxRecords ?? GDELT_DEFAULT_MAX_RECORDS, 1),
    25
  );
  const timeoutMs = params?.timeoutMs ?? GDELT_TIMEOUT_MS;
  const fetchImpl: FeedFetchLike =
    params?.fetchImpl ?? ((u, init) => fetch(u, init));

  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", params?.query ?? GDELT_DEFAULT_QUERY);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("timespan", params?.timespan ?? "2h");
  url.searchParams.set("maxrecords", String(maxRecords));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": FEED_USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `GDELT HTTP ${response.status}` };
    }

    const rawText = await response.text();
    const bounded = rawText.length > 512 * 1024 ? rawText.slice(0, 512 * 1024) : rawText;

    let parsed: GdeltDocResponse;
    try {
      parsed = JSON.parse(bounded) as GdeltDocResponse;
    } catch {
      return { ok: false, error: "GDELT returned non-JSON response" };
    }

    if (!Array.isArray(parsed.articles)) {
      return { ok: true, items: [] };
    }

    const items: GdeltItem[] = [];
    for (const rawEntry of parsed.articles) {
      if (items.length >= maxRecords) break;
      if (typeof rawEntry !== "object" || rawEntry === null) continue;

      const entry = rawEntry as GdeltArticlePayload;
      const itemUrl = typeof entry.url === "string" ? entry.url.trim() : "";
      const title =
        typeof entry.title === "string"
          ? entry.title.replace(/\s+/g, " ").trim()
          : "";
      if (!itemUrl.startsWith("https://") && !itemUrl.startsWith("http://")) {
        continue;
      }
      if (!title) continue;

      const parsedDate =
        typeof entry.seendate === "string"
          ? parseGdeltSeenDate(entry.seendate)
          : null;
      const domain =
        typeof entry.domain === "string" && entry.domain.trim()
          ? entry.domain.trim().toLowerCase()
          : extractDomainSafe(itemUrl);

      items.push({
        title: title.slice(0, 300),
        url: itemUrl,
        summary: null,
        author: null,
        publishedAt: parsedDate ?? now,
        hasExplicitDate: parsedDate !== null,
        domain,
      });
    }

    return { ok: true, items };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `GDELT fetch failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

// Parses GDELT seendate format: YYYYMMDDTHHMMSSZ (e.g. 20261119T143000Z)
export function parseGdeltSeenDate(raw: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    raw.trim()
  );
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

function extractDomainSafe(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "gdelt";
  }
}