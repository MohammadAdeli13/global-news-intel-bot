export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_USER_IDS: string;
  GEMINI_API_KEY: string;
  ENVIRONMENT?: string;
}