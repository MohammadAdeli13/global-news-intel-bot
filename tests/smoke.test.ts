import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

function createMockEnv(): Env {
  return {
    DB: {} as D1Database,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    ADMIN_USER_IDS: "123456789",
    GEMINI_API_KEY: "test-gemini-key",
    ENVIRONMENT: "test",
  };
}

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

describe("Phase 1 Worker smoke tests", () => {
  it("returns 200 OK JSON on GET /health", async () => {
    const request = new Request("https://example.com/health", {
      method: "GET",
    });

    const response = await worker.fetch(
      request,
      createMockEnv(),
      createMockCtx()
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      service: string;
      environment: string;
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("global-news-intel-bot");
    expect(body.environment).toBe("test");
  });

  it("returns 404 on unknown routes", async () => {
    const request = new Request("https://example.com/unknown", {
      method: "GET",
    });

    const response = await worker.fetch(
      request,
      createMockEnv(),
      createMockCtx()
    );

    expect(response.status).toBe(404);
  });
});