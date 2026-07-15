"use client";

/**
 * ManualSwapPanel — emergency human-in-the-loop trade override.
 *
 * Surface ONLY when the agent's global kill switch is engaged. The
 * dApp uses its connected wallet (Tonkeeper, OpenMask, etc.) to sign a
 * Ston.fi swap directly — bypassing the agent's hot wallets entirely.
 *
 * Flow:
 *   1. User fills out: jetton master, amount (TON for BUY), DEX selector.
 *   2. Component calls POST /api/dex/build-swap with the connected
 *      wallet's address. Server returns (to, value, payload(base64 BOC)).
 *   3. We invoke tonConnectUI.sendTransaction(...) — the connected
 *      wallet signs + broadcasts. We display the resulting tx hash.
 *
 * Risk: the user's gas + TON come from THEIR wallet; the agent's
 * funds are untouched. This is solely an emergency override for
 * situations when the agent's SL/TP monitor has stopped (kill switch
 * ON, daily-loss tripped, agent crashed, etc.).
 */
import { useState } from "react";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { Button } from "@/components/ui/Button";

const STONFI_ROUTER = "https://tonviewer.com/EQB3ncyBUTjZUAUOTn7f_yB-s5SscCjH-M-6f9Z6P3Z-1p";

type Phase = "idle" | "building" | "signing" | "submitting" | "done" | "error";

export function ManualSwapPanel({ killActive }: { killActive: boolean }) {
  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();

  const [jettonMaster, setJettonMaster] = useState("");
  const [amountTon, setAmountTon] = useState("0.5");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!killActive) {
    return (
      <section
        aria-label="Manual trade panel"
        className="rounded-2xl border border-border bg-panel p-5"
      >
        <h2 className="text-sm font-semibold text-fg-muted tracking-wide">
          Manual trade override
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Available only while the kill switch is engaged. Use it to manually
          exit a position if the agent&apos;s position monitor has halted or
          you want to override the autonomous tier flow.
        </p>
      </section>
    );
  }

  if (!wallet) {
    return (
      <section
        aria-label="Manual trade panel"
        className="rounded-2xl border border-amber/40 bg-amber/5 p-5"
      >
        <h2 className="text-sm font-semibold tracking-wide text-amber">
          Manual trade override — wallet required
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          The kill switch is engaged. Connect your wallet in the header to
          sign a manual swap from your own Tonkeeper / OpenMask.
        </p>
      </section>
    );
  }

  async function submit() {
    if (!wallet) return;
    setPhase("building");
    setError(null);
    setTxHash(null);
    try {
      // 1. Build the swap body server-side (Ston.fi SDK is Node-only).
      const built = await fetch("/api/dex/build-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dex: "stonfi",
          userWalletAddress: wallet.account.address,
          jettonMaster: jettonMaster.trim(),
          amountTon: side === "buy" ? Number(amountTon) : undefined,
          jettonAmountNano: side === "sell" ? "1" : undefined, // 1 nano-jetton fallback; sells disabled in builder v1
          side,
          minOutJettonNano: "1",
        }),
      });
      if (!built.ok) {
        const body = await built.json().catch(() => ({}));
        throw new Error(body?.error ?? `build-swap HTTP ${built.status}`);
      }
      const { to, value, payload, validUntil } = (await built.json()) as {
        to: string;
        value: string;
        payload: string;
        validUntil: number;
      };

      // 2. Dispatch to the user's wallet for signing.
      setPhase("signing");
      const result = await tonConnectUI.sendTransaction({
        validUntil,
        from: wallet.account.address,
        messages: [
          {
            address: to,
            amount: value,
            payload,
          },
        ],
      });
      setTxHash(result.boc?.slice(0, 16) ?? "(signed; awaiting broadcast)");
      setPhase("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // TonConnect reverts return a "User rejected" / similar; surface nicely.
      setError(msg.includes("reject") ? "rejected in wallet" : msg);
      setPhase("error");
    }
  }

  const busy =
    phase === "building" || phase === "signing" || phase === "submitting";

  return (
    <section
      aria-label="Manual trade panel"
      data-active="true"
      className="overflow-hidden rounded-2xl border border-red/40 bg-red/[0.05]"
    >
      <header className="flex items-center justify-between border-b border-red/30 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-red">
          Manual trade override
        </h2>
        <span className="mono rounded-md border border-red/40 bg-red/10 px-1.5 py-0.5 text-[11px] text-red">
          kill-switch active
        </span>
      </header>

      <div className="space-y-4 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Side">
            {/*
              SELL is disabled in v1: the swap-builder is BUY-only because
              the sell path requires per-user jetton-wallet lookup which
              isn't trivially browser-safe. Keep the tab as a discoverable
              placeholder; click is a no-op.
             */}
            <div role="tablist" className="flex gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={side === "buy"}
                onClick={() => setSide("buy")}
                className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition-colors ${
                  side === "buy"
                    ? "border-red/60 bg-red/10 text-red"
                    : "border-border-strong bg-bg-elev text-fg-muted hover:border-red/40"
                }`}
              >
                buy
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                aria-disabled="true"
                disabled
                title="Sell via TON Connect not yet supported (requires browser-side jetton-wallet lookup)"
                className="flex-1 cursor-not-allowed rounded-md border border-border bg-bg-elev px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-fg-dim opacity-50"
              >
                sell
              </button>
            </div>
            <p className="mt-1 text-[11px] text-fg-dim">
              SELL disabled in v1 — use the agent&apos;s position monitor.
            </p>
          </Field>

          <Field label="DEX">
            <div className="rounded-md border border-border-strong bg-bg-elev px-3 py-1.5 text-xs text-fg-muted">
              Ston.fi v1 (default)
            </div>
          </Field>

          <Field label={side === "buy" ? "TON in" : "Jetton master"}>
            {side === "buy" ? (
              <input
                type="number"
                min="0.05"
                step="0.05"
                value={amountTon}
                onChange={(e) => setAmountTon(e.target.value)}
                className="w-full rounded-md border border-border-strong bg-bg-elev px-3 py-1.5 text-sm text-fg outline-none focus:border-teal"
              />
            ) : (
              <input
                type="text"
                placeholder="EQ… master address"
                value={jettonMaster}
                onChange={(e) => setJettonMaster(e.target.value)}
                className="w-full rounded-md border border-border-strong bg-bg-elev px-3 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-fg-dim focus:border-teal"
              />
            )}
          </Field>
        </div>

        {side === "buy" ? (
          <Field label="Jetton master">
            <input
              type="text"
              placeholder="EQ… jetton you want to buy"
              value={jettonMaster}
              onChange={(e) => setJettonMaster(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-bg-elev px-3 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-fg-dim focus:border-teal"
            />
          </Field>
        ) : null}

        <div className="rounded-md border border-border bg-bg-elev p-3 text-xs text-fg-muted">
          <p>
            <span className="font-semibold text-fg">Funds source:</span> your
            connected wallet (
            <span className="mono">{wallet.account.address.slice(0, 6)}…</span>
            ). Gas + TON come from YOUR wallet; the agent&apos;s three tier
            wallets are NEVER touched.
          </p>
          <p className="mt-1">
            <span className="font-semibold text-fg">Slippage:</span> min out
            set to 1 nano-jetton (no protection). Edit <code>{STONFI_ROUTER}</code>
            settings before sending larger amounts.
          </p>
          {side === "sell" ? (
            <p className="mt-1 text-amber">
              Note: the v1 builder stub disables sells here. Use the BUY tab
              or exit positions via the agent&apos;s position monitor.
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-3">
          {error ? (
            <p role="alert" className="text-xs text-red">
              {error}
            </p>
          ) : null}
          {txHash ? (
            <p className="mono text-xs text-green">
              signed · first boc bytes: {txHash}
            </p>
          ) : null}
          <Button
            kind="danger"
            disabled={
              busy ||
              !jettonMaster.trim() ||
              (side === "buy" && Number(amountTon) <= 0)
            }
            onClick={submit}
            aria-label="Sign and send manual swap"
          >
            {phase === "building"
              ? "Building…"
              : phase === "signing"
                ? "Awaiting wallet…"
                : phase === "done"
                  ? "Done — sign again"
                  : "Sign & send"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-fg-dim">
        {label}
      </span>
      {children}
    </label>
  );
}
