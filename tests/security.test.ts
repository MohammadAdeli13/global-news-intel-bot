import { describe, expect, it } from "vitest";
import {
  derivePublisherGroup,
  escapeHtml,
  isAdminUser,
  validateChannelTarget,
  validateFeedUrl,
  verifyWebhookSecret,
} from "../src/security";
import { classifyTelegramSendResponse } from "../src/telegram";

describe("Phase 3 Security & Telegram Classification", () => {
  it("validates webhook secret in constant time", () => {
    expect(verifyWebhookSecret("my-super-secret", "my-super-secret")).toBe(true);
    expect(verifyWebhookSecret("my-super-secreT", "my-super-secret")).toBe(false);
    expect(verifyWebhookSecret("short", "my-super-secret")).toBe(false);
    expect(verifyWebhookSecret(null, "my-super-secret")).toBe(false);
    expect(verifyWebhookSecret("", "")).toBe(false);
  });

  it("validates admin numeric user IDs", () => {
    expect(isAdminUser(123456789, "123456789, 987654321")).toBe(true);
    expect(isAdminUser("987654321", "123456789,987654321")).toBe(true);
    expect(isAdminUser(555555555, "123456789")).toBe(false);
    expect(isAdminUser("abc", "123456789")).toBe(false);
  });

  it("blocks SSRF, HTTP, localhost, private IPs, credentials, and non-443 ports in feed URLs", () => {
    const valid = validateFeedUrl("https://feeds.bbci.co.uk/news/world/rss.xml");
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(derivePublisherGroup(valid.value)).toBe("bbci.co.uk");
    }

    const blockedUrls = [
      "http://feeds.bbci.co.uk/news/world/rss.xml",
      "https://localhost/rss.xml",
      "https://sub.localhost/rss.xml",
      "https://127.0.0.1/rss.xml",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/feed.xml",
      "https://192.168.1.1/feed.xml",
      "https://[::1]/feed.xml",
      "https://2130706433/feed.xml",
      "https://user:pass@example.com/rss.xml",
      "https://example.com:8080/rss.xml",
      "https://service.internal/rss.xml",
      "not-a-url",
    ];

    for (const url of blockedUrls) {
      expect(validateFeedUrl(url).ok, `Expected blocked: ${url}`).toBe(false);
    }
  });

  it("validates public @username and private -100 numeric channels", () => {
    expect(validateChannelTarget("@world_news_24").ok).toBe(true);
    expect(validateChannelTarget("-1001987654321").ok).toBe(true);
    expect(validateChannelTarget("@abc").ok).toBe(false);
    expect(validateChannelTarget("123456789").ok).toBe(false);
    expect(validateChannelTarget("@bad-name!").ok).toBe(false);
  });

  it("escapes HTML safely", () => {
    expect(escapeHtml(`<script>"a & b"</script>`)).toBe(
      "&lt;script&gt;&quot;a &amp; b&quot;&lt;/script&gt;"
    );
  });

  it("classifies Telegram sendMessage responses into success, retryable, permanent, and ambiguous", () => {
    expect(
      classifyTelegramSendResponse({
        transportOk: true,
        status: 200,
        httpOk: true,
        body: { ok: true, result: { message_id: 42 } },
      })
    ).toEqual({ ok: true, messageId: 42 });

    expect(
      classifyTelegramSendResponse({
        transportOk: true,
        status: 429,
        httpOk: false,
        body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 12 } },
      })
    ).toMatchObject({ ok: false, kind: "retryable", code: "RATE_LIMITED", retryAfterSeconds: 12 });

    expect(
      classifyTelegramSendResponse({
        transportOk: true,
        status: 403,
        httpOk: false,
        body: { ok: false, description: "Forbidden: bot was kicked" },
      })
    ).toMatchObject({ ok: false, kind: "permanent", code: "PERMANENT_TELEGRAM_ERROR", status: 403 });

    expect(
      classifyTelegramSendResponse({
        transportOk: true,
        status: 502,
        httpOk: false,
        body: { ok: false, description: "Bad Gateway" },
      })
    ).toMatchObject({ ok: false, kind: "ambiguous", code: "AMBIGUOUS_DELIVERY_STATE" });

    expect(
      classifyTelegramSendResponse({
        transportOk: false,
        errorDetail: "AbortError: timeout",
      })
    ).toMatchObject({ ok: false, kind: "ambiguous", code: "AMBIGUOUS_DELIVERY_STATE" });
  });
});