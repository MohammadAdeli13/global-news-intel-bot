import { describe, expect, it } from "vitest";
import { DEFAULT_NEWS_SOURCES } from "../src/feeds/default-sources";
import { fetchGdeltArticles, parseGdeltSeenDate } from "../src/feeds/gdelt";
import {
  fetchAndParseFeed,
  parseFeedXml,
  type FeedFetchLike,
  type FeedHttpResponseLike,
} from "../src/feeds/rss";
import { validateFeedUrl } from "../src/security";

function createMockResponse(params: {
  status?: number;
  ok?: boolean;
  bodyText?: string;
  headers?: Record<string, string>;
}): FeedHttpResponseLike {
  const headerMap = new Map(
    Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const text = params.bodyText ?? "";

  return {
    status: params.status ?? 200,
    ok: params.ok ?? (params.status ?? 200) < 400,
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
    async text() {
      return text;
    },
  };
}

const SAMPLE_RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>World Wire</title>
    <item>
      <title><![CDATA[Missile strike hits &amp; damages port facility]]></title>
      <link>https://news.example.com/world/strike-1?utm_source=rss</link>
      <description><![CDATA[<p>Officials confirmed <b>multiple</b> drones struck the port.</p>]]></description>
      <dc:creator>Reuters</dc:creator>
      <pubDate>Thu, 19 Nov 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Central bank cuts interest rates by 25 bps</title>
      <link>https://news.example.com/economy/rate-cut</link>
      <description>Policy makers lowered borrowing costs amid cooling inflation.</description>
      <pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const SAMPLE_ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Global Atom</title>
  <entry>
    <title>Emergency summit called over Red Sea shipping</title>
    <link rel="self" href="https://atom.example.com/api/1" />
    <link rel="alternate" href="https://atom.example.com/stories/red-sea-summit" />
    <summary>Diplomats met after renewed maritime attacks.</summary>
    <author><name>Jane Doe</name></author>
    <published>2026-11-19T11:30:00Z</published>
  </entry>
</feed>`;

describe("Phase 4 RSS/Atom & GDELT Feeds", () => {
  it("parses RSS 2.0 with CDATA, HTML stripping, entities, and dc:creator", () => {
    const items = parseFeedXml(SAMPLE_RSS_XML, { now: 1_000_000 });
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Missile strike hits & damages port facility");
    expect(items[0]?.summary).toBe("Officials confirmed multiple drones struck the port.");
    expect(items[0]?.author).toBe("Reuters");
    expect(items[0]?.hasExplicitDate).toBe(true);
    expect(items[0]?.publishedAt).toBe(Date.parse("2026-11-19T10:00:00Z"));
  });

  it("parses Atom entries and prefers rel=alternate over rel=self", () => {
    const items = parseFeedXml(SAMPLE_ATOM_XML, { now: 1_000_000 });
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://atom.example.com/stories/red-sea-summit");
    expect(items[0]?.author).toBe("Jane Doe");
    expect(items[0]?.publishedAt).toBe(Date.parse("2026-11-19T11:30:00Z"));
  });

  it("enforces maxItems cap (25 items) and handles malformed XML gracefully", () => {
    const manyItems = Array.from(
      { length: 40 },
      (_, i) =>
        `<item><title>Story ${i}</title><link>https://example.com/s/${i}</link></item>`
    ).join("");
    const bigFeed = `<rss><channel>${manyItems}</channel></rss>`;

    const items = parseFeedXml(bigFeed, { maxItems: 25, now: 5_000 });
    expect(items).toHaveLength(25);

    // Malformed / unclosed XML must return safely without throwing or stalling
    const broken = parseFeedXml("<rss><channel><item><title>Unclosed", { now: 5_000 });
    expect(broken).toEqual([]);
  });

  it("handles ETag / If-Modified-Since (304), HTTP errors, and network failures cleanly", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const mock304: FeedFetchLike = async (_url, init) => {
      sentHeaders = init?.headers;
      return createMockResponse({ status: 304, ok: false });
    };

    const res304 = await fetchAndParseFeed({
      url: "https://example.com/rss.xml",
      etag: '"abc123"',
      lastModified: "Thu, 19 Nov 2026 09:00:00 GMT",
      fetchImpl: mock304,
    });
    expect(res304.status).toBe("not_modified");
    expect(sentHeaders?.["If-None-Match"]).toBe('"abc123"');
    expect(sentHeaders?.["If-Modified-Since"]).toBe("Thu, 19 Nov 2026 09:00:00 GMT");

    const mockErr: FeedFetchLike = async () => {
      throw new Error("AbortError: timeout");
    };
    const resErr = await fetchAndParseFeed({
      url: "https://example.com/rss.xml",
      fetchImpl: mockErr,
    });
    expect(resErr.status).toBe("error");
  });

  it("parses GDELT DOC 2.0 JSON responses and handles GDELT outages gracefully", async () => {
    expect(parseGdeltSeenDate("20261119T143000Z")).toBe(
      Date.parse("2026-11-19T14:30:00Z")
    );

    const mockGdeltOk: FeedFetchLike = async () =>
      createMockResponse({
        status: 200,
        bodyText: JSON.stringify({
          articles: [
            {
              url: "https://global.example.com/energy-shock",
              title: "Oil prices surge after Red Sea tanker incident",
              seendate: "20261119T143000Z",
              domain: "global.example.com",
            },
          ],
        }),
      });

    const resOk = await fetchGdeltArticles({ fetchImpl: mockGdeltOk });
    expect(resOk.ok).toBe(true);
    if (resOk.ok) {
      expect(resOk.items).toHaveLength(1);
      expect(resOk.items[0]?.domain).toBe("global.example.com");
    }

    const mockGdeltFail: FeedFetchLike = async () =>
      createMockResponse({ status: 503, ok: false, bodyText: "Service Unavailable" });
    const resFail = await fetchGdeltArticles({ fetchImpl: mockGdeltFail });
    expect(resFail.ok).toBe(false);
  });

  it("ensures every curated default RSS source passes strict SSRF URL validation", () => {
    expect(DEFAULT_NEWS_SOURCES.length).toBeGreaterThanOrEqual(8);
    for (const src of DEFAULT_NEWS_SOURCES) {
      const check = validateFeedUrl(src.url);
      expect(check.ok, `Invalid default source URL: ${src.url}`).toBe(true);
    }
  });

  it("extracts valid HTTPS image URLs from media:content, enclosure, and description img while rejecting unsafe/video URLs", () => {
    const mediaXml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <item>
          <title>Item 1 - media:content image (skips video)</title>
          <link>https://news.example.com/1</link>
          <media:content url="https://cdn.example.com/clip.mp4" medium="video" type="video/mp4" />
          <media:content url="https://cdn.example.com/media-photo.jpg" medium="image" type="image/jpeg" />
        </item>
        <item>
          <title>Item 2 - enclosure image</title>
          <link>https://news.example.com/2</link>
          <enclosure url="https://cdn.example.com/enclosure-photo.jpg" type="image/jpeg" length="42000" />
        </item>
        <item>
          <title>Item 3 - description img fallback</title>
          <link>https://news.example.com/3</link>
          <description><![CDATA[<p><img src="https://cdn.example.com/desc-photo.png" alt="scene" />Breaking report.</p>]]></description>
        </item>
        <item>
          <title>Item 4 - unsafe HTTP and SSRF images rejected</title>
          <link>https://news.example.com/4</link>
          <media:content url="http://cdn.example.com/insecure.jpg" medium="image" />
          <enclosure url="https://127.0.0.1/internal.jpg" type="image/jpeg" />
        </item>
      </channel>
    </rss>`;

    const items = parseFeedXml(mediaXml, { now: 1_000_000 });
    expect(items).toHaveLength(4);
    expect(items[0]?.imageUrl).toBe("https://cdn.example.com/media-photo.jpg");
    expect(items[1]?.imageUrl).toBe("https://cdn.example.com/enclosure-photo.jpg");
    expect(items[2]?.imageUrl).toBe("https://cdn.example.com/desc-photo.png");
    expect(items[3]?.imageUrl).toBeNull();
  });
});