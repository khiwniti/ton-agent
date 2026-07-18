/**
 * Pure Telegram command / callback parsers (no network).
 */

export type ParsedCommand =
  | { type: "halt" }
  | { type: "resume" }
  | { type: "status" }
  | { type: "positions" }
  | { type: "caps" }
  | { type: "digest" }
  | { type: "setcap"; param: string; value: string }
  | { type: "approve"; approvalId: string }
  | { type: "deny"; approvalId: string }
  | { type: "unknown"; raw: string };

/**
 * Parse operator text commands and inline-callback data.
 * Accepts "/halt", "halt", "approve:appr_xxx", "deny:appr_xxx".
 */
export function parseTelegramCommand(raw: string): ParsedCommand {
  const text = (raw || "").trim();
  if (!text) return { type: "unknown", raw: text };

  // Callback-style
  const approveCb = text.match(/^approve[:_](.+)$/i);
  if (approveCb) return { type: "approve", approvalId: approveCb[1].trim() };
  const denyCb = text.match(/^deny[:_](.+)$/i);
  if (denyCb) return { type: "deny", approvalId: denyCb[1].trim() };

  const body = text.replace(/^\//, "").trim();
  const [cmd, ...rest] = body.split(/\s+/);
  const c = (cmd || "").toLowerCase();

  switch (c) {
    case "halt":
      return { type: "halt" };
    case "resume":
      return { type: "resume" };
    case "status":
      return { type: "status" };
    case "positions":
      return { type: "positions" };
    case "caps":
      return { type: "caps" };
    case "digest":
      return { type: "digest" };
    case "setcap":
      if (rest.length >= 2) {
        return { type: "setcap", param: rest[0], value: rest.slice(1).join(" ") };
      }
      return { type: "unknown", raw: text };
    case "approve":
      if (rest[0]) return { type: "approve", approvalId: rest[0] };
      return { type: "unknown", raw: text };
    case "deny":
      if (rest[0]) return { type: "deny", approvalId: rest[0] };
      return { type: "unknown", raw: text };
    default:
      return { type: "unknown", raw: text };
  }
}
