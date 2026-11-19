import fs from "node:fs";
import path from "node:path";

function loadDevVars() {
  const varsPath = path.resolve(process.cwd(), ".dev.vars");
  const result = {};
  if (!fs.existsSync(varsPath)) return result;

  const lines = fs.readFileSync(varsPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = val;
  }
  return result;
}

async function main() {
  const workerBaseUrl = process.argv[2]?.trim();
  if (!workerBaseUrl || !workerBaseUrl.startsWith("https://")) {
    console.error(
      "Usage: node scripts/set-webhook.mjs https://<your-worker>.workers.dev"
    );
    process.exit(1);
  }

  const devVars = loadDevVars();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || devVars.TELEGRAM_BOT_TOKEN;
  const webhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET || devVars.TELEGRAM_WEBHOOK_SECRET;

  if (!botToken || !webhookSecret) {
    console.error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET in environment or .dev.vars"
    );
    process.exit(1);
  }

  const webhookUrl = `${workerBaseUrl.replace(/\/$/, "")}/webhook`;
  const endpoint = `https://api.telegram.org/bot${botToken}/setWebhook`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    console.error("Failed to register Telegram webhook:", data);
    process.exit(1);
  }

  console.log(`Webhook successfully registered at: ${webhookUrl}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : err);
  process.exit(1);
});