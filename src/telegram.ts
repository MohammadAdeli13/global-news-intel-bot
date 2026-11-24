export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<HttpResponseLike>;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramChatMember {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  can_post_messages?: boolean;
  can_send_messages?: boolean;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

export type TelegramSendOutcome =
  | { ok: true; messageId: number }
  | {
      ok: false;
      kind: "retryable";
      code: "RATE_LIMITED";
      retryAfterSeconds: number;
      detail: string;
    }
  | {
      ok: false;
      kind: "permanent";
      code: "PERMANENT_TELEGRAM_ERROR";
      status: number;
      detail: string;
    }
  | {
      ok: false;
      kind: "ambiguous";
      code: "AMBIGUOUS_DELIVERY_STATE";
      detail: string;
    };

export const TELEGRAM_REQUEST_TIMEOUT_MS = 8_000;

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(botToken: string, fetchImpl?: FetchLike) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async callRaw(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS
  ): Promise<
    | { transportOk: true; status: number; httpOk: boolean; body: unknown }
    | { transportOk: false; errorDetail: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        return {
          transportOk: false,
          errorDetail: `Non-JSON response from Telegram (HTTP ${response.status})`,
        };
      }

      return {
        transportOk: true,
        status: response.status,
        httpOk: response.ok,
        body: parsedBody,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        transportOk: false,
        errorDetail: `Network/timeout error during ${method}: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(params: {
    chatId: string | number;
    text: string;
    parseMode?: "HTML";
    replyMarkup?: InlineKeyboardMarkup;
    replyToMessageId?: number | null;
    disableWebPagePreview?: boolean;
    linkPreviewImageUrl?: string | null;
  }): Promise<TelegramSendOutcome> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
      parse_mode: params.parseMode ?? "HTML",
      link_preview_options: params.linkPreviewImageUrl
        ? {
          is_disabled: false,
          url: params.linkPreviewImageUrl,
          prefer_large_media: true,
          show_above_text: true,
          }
        : {
          is_disabled: params.disableWebPagePreview ?? true,
          },
    };

    if (params.replyMarkup) {
      payload.reply_markup = params.replyMarkup;
    }

    if (params.replyToMessageId) {
      payload.reply_parameters = {
        message_id: params.replyToMessageId,
        allow_sending_without_reply: true,
      };
    }

    const res = await this.callRaw("sendMessage", payload);
    return classifyTelegramSendResponse(res);
  }

  async editMessageText(params: {
    chatId: string | number;
    messageId: number;
    text: string;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<boolean> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (params.replyMarkup) {
      payload.reply_markup = params.replyMarkup;
    }

    const res = await this.callRaw("editMessageText", payload);
    if (!res.transportOk) return false;
    const envelope = res.body as TelegramApiEnvelope<unknown>;
    if (envelope.ok) return true;
    // Telegram returns 400 "message is not modified" if user taps same state
    if (
      typeof envelope.description === "string" &&
      envelope.description.toLowerCase().includes("message is not modified")
    ) {
      return true;
    }
    return false;
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert: boolean = false
  ): Promise<boolean> {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
      show_alert: showAlert,
    };
    if (text) {
      payload.text = text.slice(0, 180);
    }
    const res = await this.callRaw("answerCallbackQuery", payload, 5_000);
    return res.transportOk && Boolean((res.body as TelegramApiEnvelope<unknown>).ok);
  }

  async getMe(): Promise<TelegramUser | null> {
    const res = await this.callRaw("getMe", {});
    if (!res.transportOk) return null;
    const envelope = res.body as TelegramApiEnvelope<TelegramUser>;
    return envelope.ok && envelope.result ? envelope.result : null;
  }

  async getChatMember(
    chatId: string | number,
    userId: number
  ): Promise<{ ok: true; member: TelegramChatMember } | { ok: false; description: string }> {
    const res = await this.callRaw("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
    if (!res.transportOk) {
      return { ok: false, description: res.errorDetail };
    }
    const envelope = res.body as TelegramApiEnvelope<TelegramChatMember>;
    if (envelope.ok && envelope.result) {
      return { ok: true, member: envelope.result };
    }
    return {
      ok: false,
      description: envelope.description ?? `HTTP ${res.status}`,
    };
  }

  async getChat(
    chatId: string | number
  ): Promise<{ ok: true; chat: TelegramChat } | { ok: false; description: string }> {
    const res = await this.callRaw("getChat", { chat_id: chatId });
    if (!res.transportOk) {
      return { ok: false, description: res.errorDetail };
    }
    const envelope = res.body as TelegramApiEnvelope<TelegramChat>;
    if (envelope.ok && envelope.result) {
      return { ok: true, chat: envelope.result };
    }
    return {
      ok: false,
      description: envelope.description ?? `HTTP ${res.status}`,
    };
  }

  async sendPhoto(params: {
    chatId: string | number;
    photoUrl: string;
    caption: string;
    parseMode?: "HTML";
    replyToMessageId?: number | null;
  }): Promise<TelegramSendOutcome> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      photo: params.photoUrl,
      caption: params.caption,
      parse_mode: params.parseMode ?? "HTML",
    };

    if (params.replyToMessageId) {
      payload.reply_parameters = {
        message_id: params.replyToMessageId,
        allow_sending_without_reply: true,
      };
    }

    const res = await this.callRaw("sendPhoto", payload);
    return classifyTelegramSendResponse(res);
  }

  async sendNewsPostWithMedia(params: {
    chatId: string | number;
    html: string;
    imageUrl?: string | null;
    replyToMessageId?: number | null;
  }): Promise<TelegramSendOutcome> {
    const imageUrl = params.imageUrl?.trim() || null;

    if (imageUrl && params.html.length <= 1024) {
      const photoRes = await this.sendPhoto({
        chatId: params.chatId,
        photoUrl: imageUrl,
        caption: params.html,
        parseMode: "HTML",
        replyToMessageId: params.replyToMessageId,
      });

      // Only fall back to text-only if Telegram returned a definite HTTP 400 (guaranteed not delivered)
      if (!photoRes.ok && photoRes.kind === "permanent" && photoRes.status === 400) {
        return this.sendMessage({
          chatId: params.chatId,
          text: params.html,
          parseMode: "HTML",
          replyToMessageId: params.replyToMessageId,
          disableWebPagePreview: true,
        });
      }
      return photoRes;
    }

    if (imageUrl) {
      // >1024 chars: single atomic message with large image preview above text (full 4096-char budget)
      return this.sendMessage({
        chatId: params.chatId,
        text: params.html,
        parseMode: "HTML",
        replyToMessageId: params.replyToMessageId,
        linkPreviewImageUrl: imageUrl,
      });
    }

    return this.sendMessage({
      chatId: params.chatId,
      text: params.html,
      parseMode: "HTML",
      replyToMessageId: params.replyToMessageId,
      disableWebPagePreview: true,
    });
  }
}

export function classifyTelegramSendResponse(
  res:
    | { transportOk: true; status: number; httpOk: boolean; body: unknown }
    | { transportOk: false; errorDetail: string }
): TelegramSendOutcome {
  if (!res.transportOk) {
    return {
      ok: false,
      kind: "ambiguous",
      code: "AMBIGUOUS_DELIVERY_STATE",
      detail: res.errorDetail,
    };
  }

  if (typeof res.body !== "object" || res.body === null) {
    return {
      ok: false,
      kind: "ambiguous",
      code: "AMBIGUOUS_DELIVERY_STATE",
      detail: `Unexpected non-object Telegram payload (HTTP ${res.status})`,
    };
  }

  const envelope = res.body as TelegramApiEnvelope<{ message_id?: unknown }>;

  if (res.httpOk && envelope.ok === true && typeof envelope.result?.message_id === "number") {
    return { ok: true, messageId: envelope.result.message_id };
  }

  // Strictly retryable: valid HTTP 429 JSON from Telegram
  if (res.status === 429 && envelope.ok === false) {
    const rawRetry = envelope.parameters?.retry_after;
    const retryAfterSeconds =
      typeof rawRetry === "number" && Number.isFinite(rawRetry)
        ? Math.min(Math.max(Math.ceil(rawRetry), 1), 300)
        : 30;
    return {
      ok: false,
      kind: "retryable",
      code: "RATE_LIMITED",
      retryAfterSeconds,
      detail: envelope.description ?? "Too Many Requests",
    };
  }

  // Permanent client/permission errors: 400, 401, 403, 404 with valid Telegram JSON
  if (
    (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) &&
    envelope.ok === false
  ) {
    return {
      ok: false,
      kind: "permanent",
      code: "PERMANENT_TELEGRAM_ERROR",
      status: res.status,
      detail: envelope.description ?? `Telegram client error HTTP ${res.status}`,
    };
  }

  // 5xx or malformed/unknown responses after request dispatch are strictly ambiguous
  return {
    ok: false,
    kind: "ambiguous",
    code: "AMBIGUOUS_DELIVERY_STATE",
    detail:
      envelope.description ??
      `Ambiguous Telegram response (HTTP ${res.status})`,
  };
}