import { validateImageUrl } from "../security";
export interface FeedHttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type FeedFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "follow" | "error" | "manual";
  }
) => Promise<FeedHttpResponseLike>;

export interface RawFeedItem {
  title: string;
  url: string;
  summary: string | null;
  author: string | null;
  publishedAt: number;
  hasExplicitDate: boolean;
  imageUrl: string | null;
}

export type FeedFetchResult =
  | {
      status: "ok";
      items: RawFeedItem[];
      etag: string | null;
      lastModified: string | null;
      truncated: boolean;
    }
  | {
      status: "not_modified";
      etag: string | null;
      lastModified: string | null;
    }
  | {
      status: "error";
      httpStatus?: number;
      error: string;
    };

export const FEED_TIMEOUT_MS = 5_000;
export const FEED_MAX_BYTES = 512 * 1024; // 512 KB hard cap
export const FEED_DEFAULT_MAX_ITEMS = 25;
export const FEED_USER_AGENT =
  "GlobalNewsIntelBot/1.0 (+https://developers.cloudflare.com/workers/)";

export async function fetchAndParseFeed(params: {
  url: string;
  etag?: string | null;
  lastModified?: string | null;
  maxItems?: number;
  maxBytes?: number;
  timeoutMs?: number;
  now?: number;
  fetchImpl?: FeedFetchLike;
}): Promise<FeedFetchResult> {
  const now = params.now ?? Date.now();
  const maxItems = Math.min(Math.max(params.maxItems ?? FEED_DEFAULT_MAX_ITEMS, 1), 50);
  const maxBytes = params.maxBytes ?? FEED_MAX_BYTES;
  const timeoutMs = params.timeoutMs ?? FEED_TIMEOUT_MS;
  const fetchImpl: FeedFetchLike = params.fetchImpl ?? ((u, init) => fetch(u, init));

  const headers: Record<string, string> = {
    "User-Agent": FEED_USER_AGENT,
    Accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
  };
  if (params.etag) {
    headers["If-None-Match"] = params.etag;
  }
  if (params.lastModified) {
    headers["If-Modified-Since"] = params.lastModified;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(params.url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    const nextEtag = response.headers.get("etag") ?? params.etag ?? null;
    const nextLastModified =
      response.headers.get("last-modified") ?? params.lastModified ?? null;

    if (response.status === 304) {
      return {
        status: "not_modified",
        etag: nextEtag,
        lastModified: nextLastModified,
      };
    }

    if (!response.ok) {
      return {
        status: "error",
        httpStatus: response.status,
        error: `HTTP ${response.status} fetching feed`,
      };
    }

    const { text: xml, truncated } = await readResponseTextBounded(
      response,
      maxBytes
    );
    const items = parseFeedXml(xml, { maxItems, now });

    return {
      status: "ok",
      items,
      etag: nextEtag,
      lastModified: nextLastModified,
      truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      error: `Feed fetch failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextBounded(
  response: FeedHttpResponseLike,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
    let totalBytes = 0;
    let truncated = false;
    const chunks: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const remaining = maxBytes - totalBytes;
        if (value.byteLength > remaining) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: false }));
          totalBytes = maxBytes;
          truncated = true;
          await reader.cancel();
          break;
        }

        chunks.push(decoder.decode(value, { stream: true }));
        totalBytes += value.byteLength;
      }
      if (!truncated) {
        chunks.push(decoder.decode());
      }
    } finally {
      reader.releaseLock();
    }

    return { text: chunks.join(""), truncated };
  }

  // Fallback for environments/mocks without ReadableStream body
  const rawText = await response.text();
  if (rawText.length > maxBytes) {
    return { text: rawText.slice(0, maxBytes), truncated: true };
  }
  return { text: rawText, truncated: false };
}

export function parseFeedXml(
  xml: string,
  options?: { maxItems?: number; now?: number }
): RawFeedItem[] {
  const maxItems = options?.maxItems ?? FEED_DEFAULT_MAX_ITEMS;
  const now = options?.now ?? Date.now();

  if (!xml || xml.trim().length === 0) {
    return [];
  }

  const lower = xml.toLowerCase();

  // Detect RSS <item> blocks first, otherwise Atom <entry> blocks
  const rssBlocks = extractTagBlocks(xml, lower, "item", maxItems);
  if (rssBlocks.length > 0) {
    return rssBlocks
      .map((block) => parseRssItem(block, now))
      .filter((item): item is RawFeedItem => item !== null);
  }

  const atomBlocks = extractTagBlocks(xml, lower, "entry", maxItems);
  if (atomBlocks.length > 0) {
    return atomBlocks
      .map((block) => parseAtomEntry(block, now))
      .filter((item): item is RawFeedItem => item !== null);
  }

  return [];
}

function parseRssItem(block: string, now: number): RawFeedItem | null {
  const lower = block.toLowerCase();
  const title = cleanText(extractFirstTagRaw(block, lower, ["title"]));
  const rawUrl = cleanText(
    extractFirstTagRaw(block, lower, ["link", "guid"])
  );

  if (!title || !isHttpUrl(rawUrl)) {
    return null;
  }

  const rawSummary = extractFirstTagRaw(block, lower, [
    "description",
    "content:encoded",
    "summary",
  ]);
  const summary = truncateSummary(cleanText(rawSummary));

  const rawAuthor = extractFirstTagRaw(block, lower, [
    "dc:creator",
    "author",
    "creator",
  ]);
  const author = cleanText(rawAuthor) || null;

  const rawDate = cleanText(
    extractFirstTagRaw(block, lower, ["pubdate", "dc:date", "date", "published"])
  );
  const parsedDate = parseDateSafe(rawDate);
  const imageUrl = extractItemImageUrl(block, lower, rawSummary);
  return {
    title: title.slice(0, 300),
    url: rawUrl,
    summary,
    author: author ? author.slice(0, 120) : null,
    publishedAt: parsedDate ?? now,
    hasExplicitDate: parsedDate !== null,
    imageUrl,
  };
}

function parseAtomEntry(block: string, now: number): RawFeedItem | null {
  const lower = block.toLowerCase();
  const title = cleanText(extractFirstTagRaw(block, lower, ["title"]));
  const rawUrl = extractAtomLink(block, lower);

  if (!title || !isHttpUrl(rawUrl)) {
    return null;
  }

  const rawSummary = extractFirstTagRaw(block, lower, ["summary", "content"]);
  const summary = truncateSummary(cleanText(rawSummary));

  const authorBlock = extractFirstTagRaw(block, lower, ["author"]);
  let author: string | null = null;
  if (authorBlock) {
    const authorName = cleanText(
      extractFirstTagRaw(authorBlock, authorBlock.toLowerCase(), ["name"])
    );
    author = authorName || cleanText(authorBlock) || null;
  }

  const rawDate = cleanText(
    extractFirstTagRaw(block, lower, ["published", "updated"])
  );
  const parsedDate = parseDateSafe(rawDate);

  const imageUrl = extractItemImageUrl(block, lower, rawSummary);

  return {
    title: title.slice(0, 300),
    url: rawUrl,
    summary,
    author: author ? author.slice(0, 120) : null,
    publishedAt: parsedDate ?? now,
    hasExplicitDate: parsedDate !== null,
    imageUrl,
  };
}

// Strict O(n) block extractor (no catastrophic regex backtracking)
function extractTagBlocks(
  xml: string,
  lower: string,
  tagName: string,
  maxBlocks: number
): string[] {
  const blocks: string[] = [];
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}>`;
  let pos = 0;

  while (blocks.length < maxBlocks) {
    const startIdx = lower.indexOf(openToken, pos);
    if (startIdx === -1) break;

    const afterTagChar = lower[startIdx + openToken.length];
    if (
      afterTagChar !== ">" &&
      afterTagChar !== " " &&
      afterTagChar !== "\t" &&
      afterTagChar !== "\n" &&
      afterTagChar !== "\r" &&
      afterTagChar !== "/"
    ) {
      pos = startIdx + openToken.length;
      continue;
    }

    const openEndIdx = lower.indexOf(">", startIdx + openToken.length);
    if (openEndIdx === -1) break;

    if (lower[openEndIdx - 1] === "/") {
      pos = openEndIdx + 1;
      continue;
    }

    const closeIdx = lower.indexOf(closeToken, openEndIdx + 1);
    if (closeIdx === -1) break;

    blocks.push(xml.slice(openEndIdx + 1, closeIdx));
    pos = closeIdx + closeToken.length;
  }

  return blocks;
}

function extractFirstTagRaw(
  block: string,
  lower: string,
  tagNames: readonly string[]
): string {
  for (const tagName of tagNames) {
    const openToken = `<${tagName}`;
    const closeToken = `</${tagName}>`;
    let pos = 0;

    while (pos < lower.length) {
      const startIdx = lower.indexOf(openToken, pos);
      if (startIdx === -1) break;

      const afterChar = lower[startIdx + openToken.length];
      if (
        afterChar !== ">" &&
        afterChar !== " " &&
        afterChar !== "\t" &&
        afterChar !== "\n" &&
        afterChar !== "\r" &&
        afterChar !== "/"
      ) {
        pos = startIdx + openToken.length;
        continue;
      }

      const openEndIdx = lower.indexOf(">", startIdx + openToken.length);
      if (openEndIdx === -1) break;
      if (lower[openEndIdx - 1] === "/") {
        pos = openEndIdx + 1;
        continue;
      }

      const closeIdx = lower.indexOf(closeToken, openEndIdx + 1);
      if (closeIdx === -1) break;

      const content = block.slice(openEndIdx + 1, closeIdx);
      if (content.trim().length > 0) {
        return content;
      }
      pos = closeIdx + closeToken.length;
    }
  }
  return "";
}

function extractAtomLink(block: string, lower: string): string {
  let pos = 0;
  let fallbackHref = "";

  while (pos < lower.length) {
    const idx = lower.indexOf("<link", pos);
    if (idx === -1) break;
    const afterChar = lower[idx + 5];
    if (
      afterChar !== " " &&
      afterChar !== "\t" &&
      afterChar !== "\n" &&
      afterChar !== "\r" &&
      afterChar !== ">"
    ) {
      pos = idx + 5;
      continue;
    }

    const endIdx = lower.indexOf(">", idx + 5);
    if (endIdx === -1) break;

    const tagContent = block.slice(idx, endIdx + 1);
    const href = decodeXmlEntities(extractAttr(tagContent, "href")).trim();
    const rel = extractAttr(tagContent, "rel").trim().toLowerCase();

    if (isHttpUrl(href)) {
      if (rel === "" || rel === "alternate") {
        return href;
      }
      if (!fallbackHref && rel !== "self") {
        fallbackHref = href;
      }
    }

    pos = endIdx + 1;
  }

  return fallbackHref;
}

function extractAttr(tag: string, attrName: string): string {
  const lower = tag.toLowerCase();
  const target = `${attrName.toLowerCase()}=`;
  let pos = 0;

  while (pos < lower.length) {
    const idx = lower.indexOf(target, pos);
    if (idx === -1) return "";

    const prev = idx > 0 ? lower[idx - 1] : " ";
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r") {
      pos = idx + target.length;
      continue;
    }

    const quoteIdx = idx + target.length;
    const quote = tag[quoteIdx];
    if (quote === '"' || quote === "'") {
      const endQuote = tag.indexOf(quote, quoteIdx + 1);
      if (endQuote !== -1) {
        return tag.slice(quoteIdx + 1, endQuote);
      }
    }
    return "";
  }
  return "";
}

function unwrapCdata(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("<![CDATA[") && text.endsWith("]]>")) {
    text = text.slice(9, -3);
  }
  return text;
}

function stripHtmlTagsLinear(input: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "<") {
      inTag = true;
      out += " ";
    } else if (ch === ">") {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

export function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&#(\d{1,7});/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&amp;/g, "&");
}

function cleanText(raw: string): string {
  if (!raw) return "";
  const unwrapped = unwrapCdata(raw);
  const decodedFirst = decodeXmlEntities(unwrapped);
  const noHtml = stripHtmlTagsLinear(decodedFirst);
  const decodedSecond = decodeXmlEntities(noHtml);
  return decodedSecond.replace(/\s+/g, " ").trim();
}

function truncateSummary(text: string): string | null {
  if (!text) return null;
  if (text.length <= 600) return text;
  return `${text.slice(0, 597).trimEnd()}...`;
}

function isHttpUrl(value: string): boolean {
  if (!value || value.length > 1024) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function parseDateSafe(raw: string): number | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
}

function extractItemImageUrl(
  block: string,
  lower: string,
  rawHtmlSummary: string
): string | null {
  // 1. <media:content url="..."> or <media:thumbnail url="...">
  for (const tag of ["<media:content", "<media:thumbnail"]) {
    let pos = 0;
    while (pos < lower.length) {
      const idx = lower.indexOf(tag, pos);
      if (idx === -1) break;
      const endIdx = lower.indexOf(">", idx + tag.length);
      if (endIdx === -1) break;

      const tagStr = block.slice(idx, endIdx + 1);
      const medium = extractAttr(tagStr, "medium").toLowerCase();
      const type = extractAttr(tagStr, "type").toLowerCase();
      const rawUrl = decodeXmlEntities(extractAttr(tagStr, "url")).trim();

      const isVideoOrAudio =
        medium === "video" ||
        medium === "audio" ||
        type.startsWith("video/") ||
        type.startsWith("audio/");

      if (!isVideoOrAudio) {
        const valid = validateImageUrl(rawUrl);
        if (valid) return valid;
      }
      pos = endIdx + 1;
    }
  }

  // 2. <enclosure url="..." type="image/...">
  let encPos = 0;
  while (encPos < lower.length) {
    const idx = lower.indexOf("<enclosure", encPos);
    if (idx === -1) break;
    const endIdx = lower.indexOf(">", idx + 10);
    if (endIdx === -1) break;

    const tagStr = block.slice(idx, endIdx + 1);
    const type = extractAttr(tagStr, "type").toLowerCase();
    const rawUrl = decodeXmlEntities(extractAttr(tagStr, "url")).trim();
    if (!type || type.startsWith("image/")) {
      const valid = validateImageUrl(rawUrl);
      if (valid) return valid;
    }
    encPos = endIdx + 1;
  }

  // 3. Fallback: <img src="..."> inside description/summary HTML
  if (rawHtmlSummary) {
    const decoded = decodeXmlEntities(unwrapCdata(rawHtmlSummary));
    const decodedLower = decoded.toLowerCase();
    let imgPos = 0;
    while (imgPos < decodedLower.length) {
      const idx = decodedLower.indexOf("<img", imgPos);
      if (idx === -1) break;
      const endIdx = decodedLower.indexOf(">", idx + 4);
      if (endIdx === -1) break;

      const tagStr = decoded.slice(idx, endIdx + 1);
      const rawSrc = decodeXmlEntities(extractAttr(tagStr, "src")).trim();
      const valid = validateImageUrl(rawSrc);
      if (valid) return valid;
      imgPos = endIdx + 1;
    }
  }

  return null;
}