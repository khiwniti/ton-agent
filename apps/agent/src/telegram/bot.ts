/**
 * Telegram bot stub — no-ops without TELEGRAM_BOT_TOKEN.
 * Full aiogram/telegraf wiring is Phase 3 completion; this keeps boot safe.
 */
import { log } from "../logger";

export interface TelegramBotConfig {
  token?: string;
  operatorChatId?: string;
}

export function loadTelegramConfig(): TelegramBotConfig {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || undefined,
    operatorChatId:
      process.env.TELEGRAM_OPERATOR_CHAT_ID ||
      process.env.TELEGRAM_CHAT_ID ||
      undefined,
  };
}

/**
 * Start polling only when token + chat id are present.
 * Currently logs intent and returns a stop handle (no network dependency).
 */
export function startTelegramBotIfConfigured(): { stop: () => void; enabled: boolean } {
  const cfg = loadTelegramConfig();
  if (!cfg.token || !cfg.operatorChatId) {
    log.info(
      "TELEGRAM",
      "disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID to enable HITL",
    );
    return { enabled: false, stop: () => {} };
  }

  log.info(
    "TELEGRAM",
    `configured for chat=${cfg.operatorChatId} (transport stub — approvals module is ready)`,
  );
  return {
    enabled: true,
    stop: () => log.info("TELEGRAM", "stopped"),
  };
}
