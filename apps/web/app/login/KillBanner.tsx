"use client";

/**
 * Tiny helper banner that reflects the current kill-switch state on /login.
 * Read-only: shows HALTED / LIVE pill + the last change timestamp.
 */
import { useEffect, useState } from "react";

interface KillState {
  engaged: boolean;
  at: number | null;
}

export function KillBanner() {
  const [state, setState] = useState<KillState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/kill-state", { cache: "no-store" }).catch(
          () => null,
        );
        if (!r || !r.ok) return;
        const body = (await r.json().catch(() => null)) as KillState | null;
        if (!cancelled) setState(body);
      } catch {
        // ignore — banner silent if /api/kill-state missing
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;

  return (
    <p className="mt-4 flex items-center justify-center gap-2 text-xs">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          state.engaged ? "bg-red" : "bg-green"
        }`}
      />
      <span className={state.engaged ? "text-red" : "text-green"}>
        {state.engaged ? "Agent trading HALTED" : "Agent trading live"}
      </span>
    </p>
  );
}
