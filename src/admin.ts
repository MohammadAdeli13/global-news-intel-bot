import {
  archiveSourceById,
  archiveSourceByUrl,
  enqueueJob,
  getRecentLogs,
  getSettings,
  getSystemStatusSummary,
  listActiveSources,
  listFailedOutbox,
  logSystemEvent,
  manualRetryOutbox,
  seedDefaultSettings,
  setSetting,
  upsertSource,
} from "./database";
import type { Env } from "./env";
import {
  derivePublisherGroup,
  escapeHtml,
  isAdminUser,
  validateChannelTarget,
  validateFeedUrl,
} from "./security";
import {
  TelegramClient,
  type FetchLike,
  type InlineKeyboardMarkup,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram";
import {
  NEWS_CATEGORIES,
  type AnalysisLength,
  type BotSettings,
  type CheckIntervalMinutes,
  type GeminiFallbackBehavior,
  type NewsCategory,
} from "./types";

export const CATEGORY_LABELS_FA: Record<NewsCategory, string> = {
  war_military: "جنگ و درگیری نظامی",
  missile_drone: "حملات موشکی و پهپادی",
  geopolitics_diplomacy: "ژئوپلیتیک و دیپلماسی",
  terrorism_security: "تروریسم و امنیت",
  nuclear: "تحولات هسته‌ای",
  cyber_infrastructure: "سایبری و زیرساخت حیاتی",
  sanctions_policy: "تحریم و تصمیمات سیاسی",
  energy_oil_gas: "نفت، گاز و انرژی",
  economy_finance: "بحران اقتصادی و مالی",
  central_banks: "بانک‌های مرکزی",
  natural_disasters: "بلایای طبیعی و حوادث",
  public_health: "بهداشت عمومی",
  elections_governance: "انتخابات و حکومت",
};

const VALID_INTERVALS: readonly CheckIntervalMinutes[] = [5, 10, 15, 30, 60];
const IMPORTANCE_PRESETS = [50, 60, 65, 70, 75, 80, 85] as const;
const CREDIBILITY_PRESETS = [40, 50, 55, 65, 75, 85] as const;

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  options?: { fetchImpl?: FetchLike; now?: number }
): Promise<void> {
  const now = options?.now ?? Date.now();
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, options?.fetchImpl);

  await seedDefaultSettings(env.DB, now);

  if (update.message) {
    await handleMessage(update.message, env, telegram, now);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env, telegram, now);
  }
}

async function handleMessage(
  message: TelegramMessage,
  env: Env,
  telegram: TelegramClient,
  now: number
): Promise<void> {
  // Only handle private chats from non-bot users
if (!message.from || message.from.is_bot) {
    return;
  }

  const text = (message.text ?? "").trim();
  if (!text.startsWith("/")) {
    return;
  }

  const userId = message.from.id;
  const chatId = message.chat.id;
  const firstSpace = text.indexOf(" ");
  const rawCommand = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase();
  const command = rawCommand.split("@")[0] ?? rawCommand;
  const args = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();

  if (message.chat.type !== "private") {
    if (command === "/chatid" && isAdminUser(userId, env.ADMIN_USER_IDS)) {
      await telegram.sendMessage({
        chatId,
        text:
          `🆔 شناسه این ${message.chat.type === "supergroup" ? "سوپرگروه" : "گروه"}:\n` +
          `<code>${chatId}</code>\n\n` +
          `برای تنظیم به‌عنوان مقصد، در چت خصوصی ربات بفرستید:\n` +
          `<code>/setchannel ${chatId}</code>`,
      });
    }
    return;
  }

  // /myid is allowed for any user in private chat so owners can discover their numeric ID safely
  if (command === "/myid") {
    await telegram.sendMessage({
      chatId,
      text: `🆔 شناسه عددی تلگرام شما:\n<code>${userId}</code>`,
    });
    return;
  }

  const authorized = isAdminUser(userId, env.ADMIN_USER_IDS);

  if (command === "/start" && !authorized) {
    await telegram.sendMessage({
      chatId,
      text:
        `سلام 👋\nاین ربات مخصوص رصد و انتشار خودکار اخبار است و دسترسی مدیریتی آن محدود شده است.\n\n` +
        `شناسه عددی شما: <code>${userId}</code>`,
    });
    return;
  }

  if (!authorized) {
    await logSystemEvent(
      env.DB,
      "WARN",
      "security",
      `Unauthorized command attempt: ${command}`,
      { userId, chatId },
      now
    );
    await telegram.sendMessage({
      chatId,
      text: "⛔ شما مجوز دسترسی به مدیریت این ربات را ندارید.",
    });
    return;
  }

  switch (command) {
    case "/start":
    case "/panel": {
      const settings = await getSettings(env.DB);
      const view = renderMainPanel(settings);
      await telegram.sendMessage({
        chatId,
        text: view.text,
        replyMarkup: view.markup,
      });
      return;
    }

    case "/help": {
      await telegram.sendMessage({
        chatId,
        text: renderHelpText(),
      });
      return;
    }

    case "/chatid": {
      await telegram.sendMessage({
        chatId,
        text:
          `🆔 شناسه این چت: <code>${chatId}</code>\n` +
          `برای دریافت شناسه یک گروه یا سوپرگروه، دستور <code>/chatid</code> را داخل همان گروه ارسال کنید.`,
      });
      return;
}

    case "/status": {
      const view = await renderStatusView(env.DB, now);
      await telegram.sendMessage({
        chatId,
        text: view.text,
        replyMarkup: view.markup,
      });
      return;
    }

    case "/pause": {
      await setSetting(env.DB, "isPaused", true, now);
      await logSystemEvent(env.DB, "INFO", "admin", "Bot paused by admin", { userId }, now);
      await telegram.sendMessage({
        chatId,
        text: "⏸ سیستم رصد و انتشار خبر <b>متوقف</b> شد.\nبرای شروع مجدد دستور /resume را ارسال کنید.",
      });
      return;
    }

    case "/resume": {
      await setSetting(env.DB, "isPaused", false, now);
      await logSystemEvent(env.DB, "INFO", "admin", "Bot resumed by admin", { userId }, now);
      await telegram.sendMessage({
        chatId,
        text: "▶️ سیستم رصد و انتشار خبر <b>فعال</b> شد.",
      });
      return;
    }

    case "/runonce": {
      const job = await enqueueJob(
        env.DB,
        {
          type: "RUN_ONCE",
          priority: 1,
          requestedByChatId: String(chatId),
        },
        now
      );
      await logSystemEvent(
        env.DB,
        "INFO",
        "admin",
        `Enqueued RUN_ONCE job #${job.id}`,
        { userId, jobId: job.id },
        now
      );
      await telegram.sendMessage({
        chatId,
        text:
          `✅ درخواست اجرای فوری با شناسه <code>#${job.id}</code> در صف D1 ثبت شد.\n` +
          `این درخواست به‌طور معمول در اولین نوبت Cron بعدی (با تأخیر زمانی غیرتضمینی) پردازش شده و گزارش آن همین‌جا ارسال می‌شود.`,
      });
      return;
    }

    case "/setchannel": {
      await handleSetChannelCommand(args, chatId, userId, env, telegram, now);
      return;
    }

    case "/addfeed": {
      await handleAddFeedCommand(args, chatId, userId, env, telegram, now);
      return;
    }

    case "/removefeed": {
      await handleRemoveFeedCommand(args, chatId, userId, env, telegram, now);
      return;
    }

    default: {
      await telegram.sendMessage({
        chatId,
        text: "دستور ناشناخته است. برای مشاهده راهنما /help و برای پنل مدیریت /panel را ارسال کنید.",
      });
    }
  }
}

async function handleSetChannelCommand(
  args: string,
  chatId: number,
  userId: number,
  env: Env,
  telegram: TelegramClient,
  now: number
): Promise<void> {
  if (!args) {
    await telegram.sendMessage({
      chatId,
      text:
        "فرمت صحیح:\n" +
        "<code>/setchannel @channel_username</code>\n" +
        "یا برای کانال خصوصی:\n" +
        "<code>/setchannel -1001234567890</code>",
    });
    return;
  }

  const targetArg = args.split(/\s+/)[0] ?? "";
  const validated = validateChannelTarget(targetArg);
  if (!validated.ok) {
    await telegram.sendMessage({
      chatId,
      text: `❌ ${escapeHtml(validated.reason)}`,
    });
    return;
  }

  const botUser = await telegram.getMe();
  if (!botUser) {
    await telegram.sendMessage({
      chatId,
      text: "⚠️ ارتباط با Telegram API برای بررسی دسترسی ربات ناموفق بود. لحظاتی بعد دوباره تلاش کنید.",
    });
    return;
  }

  const chatInfo = await telegram.getChat(validated.value);
  const chatType = chatInfo.ok ? chatInfo.chat.type : undefined;

  const membership = await telegram.getChatMember(validated.value, botUser.id);
  if (!membership.ok) {
    await telegram.sendMessage({
      chatId,
      text:
        `❌ ربات نتوانست مقصد <code>${escapeHtml(validated.value)}</code> را بررسی کند.\n` +
        `مطمئن شوید ربات را به کانال (به‌عنوان Admin) یا به گروه/سوپرگروه اضافه کرده‌اید.\n` +
        `جزئیات خطا: <code>${escapeHtml(membership.description)}</code>`,
    });
    return;
  }

  const isGroupLike = chatType === "group" || chatType === "supergroup";
  const canPost = isGroupLike
    ? membership.member.status === "creator" ||
      membership.member.status === "administrator" ||
      membership.member.status === "member" ||
      (membership.member.status === "restricted" &&
        membership.member.can_send_messages !== false)
    : membership.member.status === "creator" ||
      (membership.member.status === "administrator" &&
        membership.member.can_post_messages === true);

  if (!canPost) {
    await telegram.sendMessage({
      chatId,
      text: isGroupLike
        ? `❌ ربات در این گروه/سوپرگروه مجوز ارسال پیام ندارد (وضعیت: <code>${escapeHtml(membership.member.status)}</code>).`
        : `❌ ربات در کانال <code>${escapeHtml(validated.value)}</code> مجوز ارسال پیام (<b>Post Messages</b>) ندارد.\nوضعیت فعلی: <code>${escapeHtml(membership.member.status)}</code>`,
    });
    return;
  }

  await setSetting(env.DB, "targetChannel", validated.value, now);
  await logSystemEvent(
    env.DB,
    "INFO",
    "admin",
    `Target destination updated to ${validated.value} (${chatType ?? "channel"})`,
    { userId, channel: validated.value, chatType: chatType ?? "channel" },
    now
  );

  const destLabel =
    chatType === "supergroup"
      ? "سوپرگروه"
      : chatType === "group"
        ? "گروه"
        : "کانال";

  await telegram.sendMessage({
    chatId,
    text: `✅ ${destLabel} مقصد با موفقیت روی <code>${escapeHtml(validated.value)}</code> تنظیم و مجوز ارسال تأیید شد.`,
  });
}

async function handleAddFeedCommand(
  args: string,
  chatId: number,
  userId: number,
  env: Env,
  telegram: TelegramClient,
  now: number
): Promise<void> {
  if (!args) {
    await telegram.sendMessage({
      chatId,
      text:
        "فرمت صحیح:\n" +
        "<code>/addfeed https://example.com/rss.xml نام اختیاری منبع</code>",
    });
    return;
  }

  const firstSpace = args.indexOf(" ");
  const rawUrl = firstSpace === -1 ? args : args.slice(0, firstSpace);
  const customName = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

  const validated = validateFeedUrl(rawUrl);
  if (!validated.ok) {
    await logSystemEvent(
      env.DB,
      "WARN",
      "security",
      `Rejected invalid feed URL in /addfeed`,
      { userId, rawUrl, reason: validated.reason },
      now
    );
    await telegram.sendMessage({
      chatId,
      text: `❌ آدرس منبع رد شد:\n${escapeHtml(validated.reason)}`,
    });
    return;
  }

  const publisherGroup = derivePublisherGroup(validated.value);
  const name = (customName || publisherGroup).slice(0, 80);

  const source = await upsertSource(env.DB, {
    name,
    url: validated.value,
    type: "rss",
    publisherGroup,
    credibilityTier: 2,
    baseCredibility: 70,
  });

  await logSystemEvent(
    env.DB,
    "INFO",
    "admin",
    `Added/reactivated feed #${source.id}`,
    { userId, sourceId: source.id, url: source.url },
    now
  );

  await telegram.sendMessage({
    chatId,
    text:
      `✅ منبع خبری با موفقیت فعال شد:\n` +
      `• شناسه: <code>#${source.id}</code>\n` +
      `• نام: <b>${escapeHtml(source.name)}</b>\n` +
      `• گروه ناشر: <code>${escapeHtml(source.publisher_group)}</code>\n` +
      `• آدرس: <code>${escapeHtml(source.url)}</code>`,
  });
}

async function handleRemoveFeedCommand(
  args: string,
  chatId: number,
  userId: number,
  env: Env,
  telegram: TelegramClient,
  now: number
): Promise<void> {
  const target = args.trim();
  if (!target) {
    await telegram.sendMessage({
      chatId,
      text:
        "فرمت صحیح:\n" +
        "<code>/removefeed https://example.com/rss.xml</code>\n" +
        "یا با شناسه منبع از لیست منابع:\n" +
        "<code>/removefeed 3</code>",
    });
    return;
  }

  const archived = /^\d+$/.test(target)
    ? await archiveSourceById(env.DB, Number(target), now)
    : await archiveSourceByUrl(env.DB, target, now);

  if (!archived) {
    await telegram.sendMessage({
      chatId,
      text: "❌ منبع خبری فعالی با این مشخصات پیدا نشد.",
    });
    return;
  }

  await logSystemEvent(
    env.DB,
    "INFO",
    "admin",
    `Archived feed: ${target}`,
    { userId, target },
    now
  );

  await telegram.sendMessage({
    chatId,
    text: "✅ منبع خبری غیرفعال (آرشیو) شد و سوابق تاریخی مقالات آن حفظ گردید.",
  });
}

async function handleCallbackQuery(
  query: TelegramCallbackQuery,
  env: Env,
  telegram: TelegramClient,
  now: number
): Promise<void> {
  const userId = query.from.id;
  if (!isAdminUser(userId, env.ADMIN_USER_IDS)) {
    await logSystemEvent(
      env.DB,
      "WARN",
      "security",
      "Unauthorized callback_query attempt",
      { userId, data: query.data },
      now
    );
    await telegram.answerCallbackQuery(query.id, "⛔ دسترسی غیرمجاز.", true);
    return;
  }

  const data = query.data ?? "";
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    await telegram.answerCallbackQuery(query.id, "پیام پنل قابل ویرایش نیست.");
    return;
  }

  const settings = await getSettings(env.DB);
  let feedback = "به‌روزرسانی شد ✅";
  let view: { text: string; markup: InlineKeyboardMarkup } | null = null;

  if (data === "p:main") {
    view = renderMainPanel(settings);
    feedback = "منوی اصلی";
  } else if (data === "p:toggle_pause") {
    const nextPaused = !settings.isPaused;
    await setSetting(env.DB, "isPaused", nextPaused, now);
    view = renderMainPanel({ ...settings, isPaused: nextPaused });
    feedback = nextPaused ? "سیستم متوقف شد ⏸" : "سیستم فعال شد ▶️";
  } else if (data === "p:toggle_lang") {
    const nextLang = settings.language === "fa" ? "en" : "fa";
    await setSetting(env.DB, "language", nextLang, now);
    view = renderMainPanel({ ...settings, language: nextLang });
    feedback = nextLang === "fa" ? "زبان انتشار: فارسی 🇮🇷" : "زبان انتشار: انگلیسی 🇬🇧";
  } else if (data === "p:toggle_gdelt") {
    const nextGdelt = !settings.gdeltEnabled;
    await setSetting(env.DB, "gdeltEnabled", nextGdelt, now);
    view = renderMainPanel({ ...settings, gdeltEnabled: nextGdelt });
    feedback = nextGdelt ? "GDELT فعال شد ✅" : "GDELT غیرفعال شد";
  } else if (data === "p:ai") {
    view = renderAiPanel(settings);
    feedback = "تنظیمات هوش مصنوعی";
  } else if (data === "p:ai_toggle") {
    const nextAi = !settings.geminiEnabled;
    await setSetting(env.DB, "geminiEnabled", nextAi, now);
    view = renderAiPanel({ ...settings, geminiEnabled: nextAi });
    feedback = nextAi ? "تحلیل Gemini فعال شد" : "تحلیل Gemini غیرفعال شد";
  } else if (data.startsWith("p:ai_len:")) {
    const len = data.slice("p:ai_len:".length) as AnalysisLength;
    if (len === "short" || len === "medium" || len === "detailed") {
      await setSetting(env.DB, "analysisLength", len, now);
      view = renderAiPanel({ ...settings, analysisLength: len });
    }
  } else if (data.startsWith("p:ai_fb:")) {
    const fb = data.slice("p:ai_fb:".length) as GeminiFallbackBehavior;
    if (fb === "queue" || fb === "publish_without_ai") {
      await setSetting(env.DB, "geminiFallbackBehavior", fb, now);
      view = renderAiPanel({ ...settings, geminiFallbackBehavior: fb });
    }
  } else if (data === "p:scores") {
    view = renderScoresPanel(settings);
    feedback = "آستانه‌های امتیاز";
  } else if (data.startsWith("p:imp:")) {
    const val = Number(data.slice("p:imp:".length));
    if (Number.isInteger(val) && val >= 0 && val <= 100) {
      await setSetting(env.DB, "minImportanceScore", val, now);
      view = renderScoresPanel({ ...settings, minImportanceScore: val });
    }
  } else if (data.startsWith("p:cred:")) {
    const val = Number(data.slice("p:cred:".length));
    if (Number.isInteger(val) && val >= 0 && val <= 100) {
      await setSetting(env.DB, "minCredibilityScore", val, now);
      view = renderScoresPanel({ ...settings, minCredibilityScore: val });
    }
  } else if (data === "p:limits") {
    view = renderLimitsPanel(settings);
    feedback = "زمان‌بندی و سقف انتشار";
  } else if (data.startsWith("p:int:")) {
    const val = Number(data.slice("p:int:".length)) as CheckIntervalMinutes;
    if (VALID_INTERVALS.includes(val)) {
      await setSetting(env.DB, "checkIntervalMinutes", val, now);
      view = renderLimitsPanel({ ...settings, checkIntervalMinutes: val });
    }
  } else if (data.startsWith("p:hr:")) {
    const delta = Number(data.slice("p:hr:".length));
    if (Number.isInteger(delta)) {
      const next = Math.min(Math.max(settings.maxPostsPerHour + delta, 1), 20);
      await setSetting(env.DB, "maxPostsPerHour", next, now);
      view = renderLimitsPanel({ ...settings, maxPostsPerHour: next });
    }
  } else if (data.startsWith("p:day:")) {
    const delta = Number(data.slice("p:day:".length));
    if (Number.isInteger(delta)) {
      const next = Math.min(Math.max(settings.maxPostsPerDay + delta, 1), 100);
      await setSetting(env.DB, "maxPostsPerDay", next, now);
      view = renderLimitsPanel({ ...settings, maxPostsPerDay: next });
    }
  } else if (data === "p:cats") {
    view = renderCategoriesPanel(settings);
    feedback = "دسته‌بندی‌های خبری";
  } else if (data.startsWith("p:cat:")) {
    const idx = Number(data.slice("p:cat:".length));
    const category = NEWS_CATEGORIES[idx];
    if (category) {
      const current = new Set(settings.enabledCategories);
      if (current.has(category)) {
        current.delete(category);
      } else {
        current.add(category);
      }
      const nextCategories = NEWS_CATEGORIES.filter((c) => current.has(c));
      await setSetting(env.DB, "enabledCategories", nextCategories, now);
      view = renderCategoriesPanel({ ...settings, enabledCategories: nextCategories });
    }
  } else if (data === "p:feeds") {
    view = await renderFeedsPanel(env.DB);
    feedback = "منابع خبری";
  } else if (data === "p:channel") {
    view = renderChannelPanel(settings);
    feedback = "تنظیم کانال مقصد";
  } else if (data === "p:status") {
    view = await renderStatusView(env.DB, now);
    feedback = "وضعیت سیستم به‌روز شد";
  } else if (data === "p:job:run_once") {
    const job = await enqueueJob(
      env.DB,
      { type: "RUN_ONCE", priority: 1, requestedByChatId: String(chatId) },
      now
    );
    feedback = `Job بررسی فوری #${job.id} ثبت شد (اجرا در نوبت Cron بعدی).`;
    view = await renderStatusView(env.DB, now);
  } else if (data === "p:job:test_feeds") {
    const job = await enqueueJob(
      env.DB,
      { type: "TEST_FEEDS", priority: 2, requestedByChatId: String(chatId) },
      now
    );
    feedback = `Job تست منابع #${job.id} ثبت شد (اجرا در نوبت Cron بعدی).`;
    view = await renderFeedsPanel(env.DB);
  } else if (data.startsWith("p:retry:")) {
    const outboxId = Number(data.slice("p:retry:".length));
    if (Number.isInteger(outboxId) && outboxId > 0) {
      const ok = await manualRetryOutbox(env.DB, outboxId, String(userId), now);
      feedback = ok
        ? `ارسال مجدد #${outboxId} تأیید و در لاگ ممیزی ثبت شد ✅`
        : "این مورد دیگر در وضعیت FAILED نیست.";
      view = await renderStatusView(env.DB, now);
    }
  } else if (data === "p:toggle_images") {
    const nextImages = !settings.includeImages;
    await setSetting(env.DB, "includeImages", nextImages, now);
    view = renderMainPanel({ ...settings, includeImages: nextImages });
    feedback = nextImages ? "نمایش تصویر در پست‌ها فعال شد 🖼" : "نمایش تصویر در پست‌ها غیرفعال شد";
  } else {
    feedback = "عملیات ناشناخته";
  }

  await telegram.answerCallbackQuery(query.id, feedback);

  if (view) {
    await telegram.editMessageText({
      chatId,
      messageId,
      text: view.text,
      replyMarkup: view.markup,
    });
  }
}

// ============================================================================
// Panel Renderers (Persian UI)
// ============================================================================

function renderHelpText(): string {
  return [
    "📘 <b>راهنمای دستورات مدیریت ربات</b>",
    "",
    "• /panel — باز کردن پنل مدیریتی دکمه‌ای",
    "• /status — مشاهده وضعیت سیستم، خطاها و پیام‌های ناموفق",
    "• /pause — توقف موقت رصد و انتشار",
    "• /resume — شروع مجدد سیستم",
    "• /runonce — ثبت درخواست بررسی فوری در صف Cron",
    "• /setchannel <code>@username</code> یا <code>-100...</code> یا <code>-...</code> — تنظیم مقصد انتشار (کانال، سوپرگروه یا گروه عادی)",
    "• /chatid — نمایش شناسه عددی چت (ارسال داخل گروه یا سوپرگروه برای دریافت آیدی آن)",
    "• /addfeed <code>https://... [نام]</code> — افزودن منبع خبری RSS/Atom",
    "• /removefeed <code>url یا شناسه</code> — غیرفعال‌سازی منبع خبری (با حفظ تاریخچه)",
    "• /myid — نمایش شناسه عددی شما",
  ].join("\n");
}

function renderMainPanel(settings: BotSettings): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  const statusBadge = settings.isPaused ? "⏸ متوقف" : "🟢 فعال";
  const channelText = settings.targetChannel
    ? `<code>${escapeHtml(settings.targetChannel)}</code>`
    : "⚠️ تنظیم نشده";
  const langText = settings.language === "fa" ? "فارسی 🇮🇷" : "انگلیسی 🇬🇧";
  const aiText = settings.geminiEnabled ? "فعال ✅" : "غیرفعال ❌";
  const gdeltText = settings.gdeltEnabled ? "فعال ✅" : "غیرفعال";
  const imagesText = settings.includeImages ? "فعال ✅" : "غیرفعال";

  const text = [
    "🎛 <b>پنل مدیریت ربات رصد اخبار جهان</b>",
    "",
    `• وضعیت سیستم: <b>${statusBadge}</b>`,
    `• مقصد انتشار: ${channelText}`,
    `• زبان انتشار: <b>${langText}</b>`,
    `• تحلیل Gemini: <b>${aiText}</b> | GDELT: <b>${gdeltText}</b>`,
    `• تصاویر پست‌ها: <b>${imagesText}</b>`,
    `• آستانه‌ها: اهمیت <b>${settings.minImportanceScore}</b> | اعتبار <b>${settings.minCredibilityScore}</b>`,
    `• بازه بررسی: هر <b>${settings.checkIntervalMinutes} دقیقه</b> | سقف: <b>${settings.maxPostsPerHour}/ساعت</b> و <b>${settings.maxPostsPerDay}/روز</b>`,
    `• دسته‌های فعال: <b>${settings.enabledCategories.length}</b> از ${NEWS_CATEGORIES.length}`,
  ].join("\n");

  const markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: settings.isPaused ? "▶️ شروع مجدد" : "⏸ توقف سیستم",
          callback_data: "p:toggle_pause",
        },
        {
          text: settings.language === "fa" ? "🌐 زبان: فارسی" : "🌐 Language: EN",
          callback_data: "p:toggle_lang",
        },
      ],
      [
        { text: "📡 منابع خبری", callback_data: "p:feeds" },
        { text: "📢 مقصد انتشار", callback_data: "p:channel" },
      ],
      [
        { text: "🗂 دسته‌بندی‌ها", callback_data: "p:cats" },
        { text: "🎯 آستانه‌های امتیاز", callback_data: "p:scores" },
      ],
      [
        { text: "🤖 تنظیمات Gemini", callback_data: "p:ai" },
        { text: "⏱ زمان‌بندی و سقف‌ها", callback_data: "p:limits" },
      ],
      [
        {
          text: settings.gdeltEnabled ? "🌍 GDELT: فعال" : "🌍 GDELT: غیرفعال",
          callback_data: "p:toggle_gdelt",
        },
        {
          text: settings.includeImages ? "🖼 تصاویر: فعال" : "🖼 تصاویر: غیرفعال",
          callback_data: "p:toggle_images",
        },
      ],
      [
        { text: "⚡ بررسی فوری (Job)", callback_data: "p:job:run_once" },
        { text: "📊 وضعیت و لاگ‌ها", callback_data: "p:status" },
      ],
    ],
  };

  return { text, markup };
}

function renderAiPanel(settings: BotSettings): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  const lenMap: Record<AnalysisLength, string> = {
    short: "کوتاه",
    medium: "متوسط",
    detailed: "کامل",
  };
  const fbMap: Record<GeminiFallbackBehavior, string> = {
    publish_without_ai: "انتشار بدون تحلیل",
    queue: "نگه‌داری در صف تا بازگشت سهمیه",
  };

  const text = [
    "🤖 <b>تنظیمات تحلیل هوش مصنوعی (Gemini)</b>",
    "",
    `• وضعیت: <b>${settings.geminiEnabled ? "فعال ✅" : "غیرفعال ❌"}</b>`,
    `• مدل اصلی: <code>${escapeHtml(settings.geminiModel)}</code>`,
    `• مدل پشتیبان: <code>${escapeHtml(settings.geminiFallbackModel)}</code>`,
    `• مدل اضطراری سوم: <code>${escapeHtml(settings.geminiEmergencyModel)}</code>`,
    `• سقف روزانه نرم: <b>${settings.geminiDailyLimit}</b> درخواست`,
    `• طول تحلیل: <b>${lenMap[settings.analysisLength]}</b>`,
    `• رفتار هنگام خطا/اتمام سهمیه: <b>${fbMap[settings.geminiFallbackBehavior]}</b>`,
  ].join("\n");

  const markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: settings.geminiEnabled ? "🔴 غیرفعال کردن Gemini" : "🟢 فعال کردن Gemini",
          callback_data: "p:ai_toggle",
        },
      ],
      [
        {
          text: `${settings.analysisLength === "short" ? "✅ " : ""}کوتاه`,
          callback_data: "p:ai_len:short",
        },
        {
          text: `${settings.analysisLength === "medium" ? "✅ " : ""}متوسط`,
          callback_data: "p:ai_len:medium",
        },
        {
          text: `${settings.analysisLength === "detailed" ? "✅ " : ""}کامل`,
          callback_data: "p:ai_len:detailed",
        },
      ],
      [
        {
          text: `${settings.geminiFallbackBehavior === "publish_without_ai" ? "✅ " : ""}انتشار بدون تحلیل`,
          callback_data: "p:ai_fb:publish_without_ai",
        },
        {
          text: `${settings.geminiFallbackBehavior === "queue" ? "✅ " : ""}نگه‌داری در صف`,
          callback_data: "p:ai_fb:queue",
        },
      ],
      [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "p:main" }],
    ],
  };

  return { text, markup };
}

function renderScoresPanel(settings: BotSettings): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  const text = [
    "🎯 <b>آستانه‌های امتیاز برای انتشار خبر</b>",
    "",
    `• حداقل امتیاز اهمیت (Importance): <b>${settings.minImportanceScore}</b> از ۱۰۰`,
    `• حداقل امتیاز اعتبار منبع (Credibility): <b>${settings.minCredibilityScore}</b> از ۱۰۰`,
  ].join("\n");

  const impRow = IMPORTANCE_PRESETS.map((v) => ({
    text: `${settings.minImportanceScore === v ? "✅" : ""}${v}`,
    callback_data: `p:imp:${v}`,
  }));
  const credRow = CREDIBILITY_PRESETS.map((v) => ({
    text: `${settings.minCredibilityScore === v ? "✅" : ""}${v}`,
    callback_data: `p:cred:${v}`,
  }));

  return {
    text,
    markup: {
      inline_keyboard: [
        [{ text: "— حداقل اهمیت (Importance) —", callback_data: "p:scores" }],
        impRow.slice(0, 4),
        impRow.slice(4),
        [{ text: "— حداقل اعتبار (Credibility) —", callback_data: "p:scores" }],
        credRow.slice(0, 3),
        credRow.slice(3),
        [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "p:main" }],
      ],
    },
  };
}

function renderLimitsPanel(settings: BotSettings): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  const text = [
    "⏱ <b>زمان‌بندی بررسی و سقف انتشار</b>",
    "",
    `• فاصله بررسی اخبار: هر <b>${settings.checkIntervalMinutes} دقیقه</b>`,
    `• سقف انتشار ساعتی: <b>${settings.maxPostsPerHour}</b> خبر`,
    `• سقف انتشار روزانه: <b>${settings.maxPostsPerDay}</b> خبر`,
    `• بودجه محافظه‌کارانه فید در هر تیک: <b>${settings.maxFeedsPerTick}</b> فید`,
  ].join("\n");

  const intervalRow = VALID_INTERVALS.map((m) => ({
    text: `${settings.checkIntervalMinutes === m ? "✅" : ""}${m}m`,
    callback_data: `p:int:${m}`,
  }));

  return {
    text,
    markup: {
      inline_keyboard: [
        intervalRow,
        [
          { text: "➖ ساعتی", callback_data: "p:hr:-1" },
          { text: `ساعتی: ${settings.maxPostsPerHour}`, callback_data: "p:limits" },
          { text: "➕ ساعتی", callback_data: "p:hr:1" },
        ],
        [
          { text: "➖ روزانه (-5)", callback_data: "p:day:-5" },
          { text: `روزانه: ${settings.maxPostsPerDay}`, callback_data: "p:limits" },
          { text: "➕ روزانه (+5)", callback_data: "p:day:5" },
        ],
        [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "p:main" }],
      ],
    },
  };
}

function renderCategoriesPanel(settings: BotSettings): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  const activeSet = new Set(settings.enabledCategories);
  const warning =
    activeSet.size === 0
      ? "\n⚠️ هیچ دسته‌ای فعال نیست و خبری منتشر نخواهد شد."
      : "";

  const text =
    `🗂 <b>مدیریت دسته‌های خبری (${activeSet.size}/${NEWS_CATEGORIES.length} فعال)</b>\n` +
    `برای فعال یا غیرفعال کردن هر موضوع روی آن بزنید:${warning}`;

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let i = 0; i < NEWS_CATEGORIES.length; i += 2) {
    const row = [];
    const catA = NEWS_CATEGORIES[i];
    if (catA) {
      row.push({
        text: `${activeSet.has(catA) ? "✅" : "❌"} ${CATEGORY_LABELS_FA[catA]}`,
        callback_data: `p:cat:${i}`,
      });
    }
    const catB = NEWS_CATEGORIES[i + 1];
    if (catB) {
      row.push({
        text: `${activeSet.has(catB) ? "✅" : "❌"} ${CATEGORY_LABELS_FA[catB]}`,
        callback_data: `p:cat:${i + 1}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "🔙 بازگشت به پنل اصلی", callback_data: "p:main" }]);

  return { text, markup: { inline_keyboard: rows } };
}

async function renderFeedsPanel(
  db: D1Database
): Promise<{ text: string; markup: InlineKeyboardMarkup }> {
  const sources = await listActiveSources(db);
  const lines = ["📡 <b>منابع خبری فعال</b>", ""];

  if (sources.length === 0) {
    lines.push("هنوز هیچ منبع خبری فعالی ثبت نشده است.");
  } else {
    for (const src of sources.slice(0, 15)) {
      const errBadge = src.consecutive_failures > 0 ? ` ⚠️(${src.consecutive_failures} خطا)` : "";
      lines.push(
        `• <code>#${src.id}</code> <b>${escapeHtml(src.name)}</b> [T${src.credibility_tier}/${src.base_credibility}]${errBadge}`
      );
    }
    if (sources.length > 15) {
      lines.push(`... و ${sources.length - 15} منبع دیگر.`);
    }
  }

  lines.push(
    "",
    "➕ افزودن منبع: <code>/addfeed https://... نام</code>",
    "🗑 غیرفعال‌سازی: <code>/removefeed شناسه یا آدرس</code>"
  );

  return {
    text: lines.join("\n"),
    markup: {
      inline_keyboard: [
        [{ text: "🧪 ثبت Job تست منابع خبری", callback_data: "p:job:test_feeds" }],
        [{ text: "🔙 بازگشت به پنل اصلی", callback_data: "p:main" }],
      ],
    },
  };
}

function renderChannelPanel(settings: BotSettings): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  const current = settings.targetChannel
    ? `<code>${escapeHtml(settings.targetChannel)}</code>`
    : "⚠️ هنوز مقصدی تنظیم نشده است.";

  const text = [
    "📢 <b>تنظیم مقصد انتشار (کانال، سوپرگروه یا گروه)</b>",
    "",
    `مقصد فعلی: ${current}`,
    "",
    "برای تنظیم یا تغییر مقصد بدون تغییر کد:",
    "۱) در <b>کانال</b>: ربات را Admin کنید و مجوز <b>Post Messages</b> بدهید.",
    "۲) در <b>گروه یا سوپرگروه</b>: ربات را عضو گروه کنید (و در صورت نیاز مجوز ارسال پیام بدهید). برای گرفتن شناسه، دستور <code>/chatid</code> را داخل همان گروه بفرستید.",
    "",
    "سپس در همین چت خصوصی دستور مناسب را ارسال کنید:",
    "• کانال یا سوپرگروه عمومی: <code>/setchannel @username</code>",
    "• کانال خصوصی یا سوپرگروه: <code>/setchannel -1001234567890</code>",
    "• گروه عادی: <code>/setchannel -123456789</code>",
  ].join("\n");

  return {
    text,
    markup: {
      inline_keyboard: [[{ text: "🔙 بازگشت به پنل اصلی", callback_data: "p:main" }]],
    },
  };
}

async function renderStatusView(
  db: D1Database,
  now: number
): Promise<{ text: string; markup: InlineKeyboardMarkup }> {
  const [settings, summary, recentLogs, failedOutbox] = await Promise.all([
    getSettings(db),
    getSystemStatusSummary(db, now),
    getRecentLogs(db, 5),
    listFailedOutbox(db, 3),
  ]);

  const lines = [
    "📊 <b>وضعیت سیستم رصد اخبار</b>",
    "",
    `• وضعیت اجرا: <b>${settings.isPaused ? "⏸ متوقف" : "🟢 فعال"}</b>`,
    `• کانال مقصد: ${settings.targetChannel ? `<code>${escapeHtml(settings.targetChannel)}</code>` : "تنظیم نشده"}`,
    `• منابع فعال: <b>${summary.activeSources}</b>`,
    `• صف آماده انتشار: <b>${summary.queuedClusters}</b> | Jobهای فعال: <b>${summary.pendingJobs}</b>`,
    `• انتشار: <b>${summary.publishedLastHour}</b> (ساعت اخیر) | <b>${summary.publishedLast24Hours}</b> (۲۴ ساعت) | <b>${summary.publishedTotal}</b> کل`,
    `• خطاهای ۲۴ ساعت اخیر: <b>${summary.recentErrorCount}</b> | ارسال‌های ناموفق Outbox: <b>${summary.failedOutboxCount}</b>`,
  ];

  if (failedOutbox.length > 0) {
    lines.push("", "⚠️ <b>موارد Outbox نیازمند بررسی دستی ادمین:</b>");
    for (const item of failedOutbox) {
      lines.push(
        `• Outbox <code>#${item.id}</code> (خوشه #${item.cluster_id} / نسخه ${item.revision_number}) — <code>${escapeHtml(item.failure_code ?? "FAILED")}</code>`
      );
    }
  }

  if (recentLogs.length > 0) {
    lines.push("", "📝 <b>آخرین رویدادها:</b>");
    for (const log of recentLogs) {
      const cleanMsg = log.message.replace(/\s+/g, " ").trim().slice(0, 150);
      lines.push(`• [${log.level}] <code>${escapeHtml(log.component)}</code>: ${escapeHtml(cleanMsg)}`);
    }
  }

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const item of failedOutbox) {
    rows.push([
      {
        text: `🔁 تأیید ارسال مجدد دستی Outbox #${item.id}`,
        callback_data: `p:retry:${item.id}`,
      },
    ]);
  }
  rows.push([
    { text: "🔄 تازه‌سازی وضعیت", callback_data: "p:status" },
    { text: "🔙 پنل اصلی", callback_data: "p:main" },
  ]);

  return {
    text: lines.join("\n"),
    markup: { inline_keyboard: rows },
  };
}