import { handleTelegramUpdate } from "./admin";
import { logSystemEvent, recordTelegramUpdateIfNew } from "./database";
import type { Env } from "./env";
import { runScheduledPipeline } from "./news";
import { verifyWebhookSecret } from "./security";
import type { TelegramUpdate } from "./telegram";

const worker = {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          service: "global-news-intel-bot",
          environment: env.ENVIRONMENT ?? "development",
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!verifyWebhookSecret(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      if (typeof update?.update_id !== "number") {
        return Response.json({ error: "Missing update_id" }, { status: 400 });
      }

      const isNew = await recordTelegramUpdateIfNew(env.DB, update.update_id);
      if (!isNew) {
        return Response.json({ ok: true, duplicate: true }, { status: 200 });
      }

      try {
        await handleTelegramUpdate(update, env);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await logSystemEvent(env.DB, "ERROR", "webhook", "Unhandled webhook error", {
          updateId: update.update_id,
          detail,
        });
      }

      return Response.json({ ok: true }, { status: 200 });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const summary = await runScheduledPipeline(env);
    console.log(
      JSON.stringify({
        level: "INFO",
        component: "cron",
        message: "Scheduled pipeline completed",
        summary,
      })
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;