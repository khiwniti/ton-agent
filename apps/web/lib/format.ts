/** Formatting helpers for addresses, TON amounts, PnL, timestamps. */

/** Truncate a TON/jetton address: EQAbc…wxyz */
export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Format a TON amount with fixed precision. */
export function formatTon(value: number | null | undefined, dp = 3): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Signed PnL string, e.g. "+1.234" / "-0.560". */
export function formatPnl(value: number | null | undefined, dp = 3): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(dp)}`;
}

/** Signed percentage, e.g. "+12.5%". */
export function formatPct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(dp)}%`;
}

/** Epoch-ms (or ISO string) → local HH:MM:SS. */
export function formatTime(input: number | string | null | undefined): string {
  if (input === null || input === undefined) return "—";
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour12: false });
}

/** Epoch-ms (or ISO string) → local date + time. */
export function formatDateTime(
  input: number | string | null | undefined,
): string {
  if (input === null || input === undefined) return "—";
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { hour12: false });
}

/** Seconds → "1d 2h 3m". */
export function formatUptime(sec: number | null | undefined): string {
  if (!sec || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}
