import type { Env } from "./env";

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

    return Response.json({ error: "Not Found" }, { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(
      JSON.stringify({
        level: "INFO",
        component: "cron",
        message: "Scheduled heartbeat triggered",
        cron: controller.cron,
        scheduledTime: new Date(controller.scheduledTime).toISOString(),
      })
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;