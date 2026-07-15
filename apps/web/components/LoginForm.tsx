"use client";

/**
 * LoginForm — dual-mode sign-in.
 *
 *   Primary: TON Connect proof-of-ownership.
 *     1. Click "Connect wallet to sign in".
 *     2. We POST /api/auth/wallet/challenge → mint nonce.
 *     3. setConnectRequestParameters({ tonProof: { payload } }) BEFORE opening.
 *        We also call setConnectRequestParameters(null) FIRST to clear any
 *        stale params from a previous attempt — the SDK requires this on
 *        retry flows.
 *     4. Use `tonConnectUI.openModal()` (no args; opens the wallet picker).
 *        The older `openSingleWalletModal(walletName)` requires a wallet
 *        name and is not the right primitive for "let the user pick any".
 *     5. useEffect: when `useTonWallet()` returns a wallet that includes
 *        a `ton_proof` connectItem, we POST /api/auth/wallet/verify.
 *     6. On success, router.push(next); router.refresh().
 *
 *   Fallback: Password input — only rendered when ENABLE_PASSWORD_LOGIN is
 *   set server-side (we render an env-guarded slot). The ADMIN_PASSWORD is
 *   the only thing that matters; blank password = disabled.
 *
 * The AccessMode copy comes from /api/auth/login's GET handler returning
 * { password_enabled: boolean } — see the matching route.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { Button } from "@/components/ui/Button";

type Phase = "idle" | "challenging" | "opening" | "verifying" | "ok" | "error" | "stuck";

// 30-second upper bound on a wallet connection that produces no ton_proof.
const PROOF_TIMEOUT_MS = 30_000;

export function LoginForm() {
  return (
    <Suspense>
      <LoginFormInner />
    </Suspense>
  );
}

function LoginFormInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const next = sp.get("next") ?? "/dashboard";

  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [passwordEnabled, setPasswordEnabled] = useState(false);

  const [password, setPassword] = useState("");
  const [pwStatus, setPwStatus] = useState<"idle" | "sending" | "ok" | "err">(
    "idle",
  );
  const [pwError, setPwError] = useState<string | null>(null);

  // Probe whether the server has ENABLE_PASSWORD_LOGIN=true.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/auth/login", {
          method: "GET",
        }).catch(() => null);
        if (r && r.ok && !cancelled) {
          const body = await r.json().catch(() => ({}));
          if (typeof body?.password_enabled === "boolean") {
            setPasswordEnabled(body.password_enabled);
            return;
          }
        }
        if (!cancelled) setPasswordEnabled(false);
      } catch {
        if (!cancelled) setPasswordEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Step 1+2 of the wallet flow: mint a challenge, set the connect request
   * proof params, then open the modal. We do these atomically because
   * `setConnectRequestParameters` MUST be called BEFORE the modal opens.
   */
  async function startWalletFlow() {
    setPhase("challenging");
    setError(null);
    openedAt.current = null;
    try {
      const ch = await fetch("/api/auth/wallet/challenge", {
        method: "POST",
      });
      if (!ch.ok) {
        const body = await ch.json().catch(() => ({}));
        throw new Error(body?.error ?? `challenge HTTP ${ch.status}`);
      }
      const { payload } = (await ch.json()) as {
        payload: string;
        app_domain: string;
        expires_at: number;
      };

      // Tell the UI SDK: ask the wallet to sign a ton_proof with our
      // payload. We also clear any stale params first (retry safety).
      // Cast `as any` because @tonconnect/ui-react 2.4.4's typed
      // ConnectAdditionalRequest shape varies across patches.
      const ui = tonConnectUI as any;
      ui.setConnectRequestParameters(null);
      ui.setConnectRequestParameters({ tonProof: { payload } });

      setPhase("opening");
      await ui.openModal();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("error");
    }
  }

  /**
   * Timeout watchdog: if 30s pass with a connected wallet but no ton_proof
   * surfaced, drop to "stuck" and surface a recoverable error message.
   */
  const openedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!wallet) {
      openedAt.current = null;
      return;
    }
    if (phase === "opening") openedAt.current = Date.now();
    if (openedAt.current && phase !== "ok" && phase !== "idle") {
      const elapsed = Date.now() - openedAt.current;
      if (elapsed > PROOF_TIMEOUT_MS) {
        setError(
          "Connected wallet did not produce a proof signature. Some wallets (older OpenMask, certain Ledger flows) do not support TON Connect proof-of-ownership. Try Tonkeeper.",
        );
        setPhase("stuck");
        return;
      }
    }
  }, [wallet, phase]);

  /**
   * Phase verify step: as soon as useTonWallet() returns a connected wallet,
   * look for a `ton_proof` connectItem. The TON Connect UI SDK exposes
   * `wallet.connectItems` — handle it as either object form (newer spec) or
   * array form (older spec) defensively.
   */
  useEffect(() => {
    if (!wallet || phase === "verifying" || phase === "ok" || phase === "stuck") return;

    const items = wallet.connectItems;
    // After the guards below, payload + signature are non-null strings.
    // We Materialise the proof object as a concrete shape so the body that
    // /api/auth/wallet/verify receives is type-stable.
    let proofMaterialised: {
      payload: string;
      signature: string;
      state_init?: string;
    } | null = null;

    if (items && !Array.isArray(items) && typeof items === "object") {
      const tp = (items as { ton_proof?: unknown }).ton_proof;
      if (tp && typeof tp === "object") {
        const p = tp as { payload?: unknown; signature?: unknown; state_init?: unknown };
        if (typeof p.payload === "string" && typeof p.signature === "string") {
          proofMaterialised = {
            payload: p.payload,
            signature: p.signature,
            state_init: typeof p.state_init === "string" ? p.state_init : undefined,
          };
        }
      }
    }
    if (!proofMaterialised && Array.isArray(items)) {
      const tp = items.find((i: { type?: unknown }) => i?.type === "ton_proof") as
        | { payload?: unknown; signature?: unknown; state_init?: unknown }
        | undefined;
      if (
        tp &&
        typeof tp.payload === "string" &&
        typeof tp.signature === "string"
      ) {
        proofMaterialised = {
          payload: tp.payload,
          signature: tp.signature,
          state_init: typeof tp.state_init === "string" ? tp.state_init : undefined,
        };
      }
    }

    if (!proofMaterialised) return;

    setPhase("verifying");
    setError(null);
    void (async () => {
      try {
        const r = await fetch("/api/auth/wallet/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_address: wallet.account.address,
            payload: proofMaterialised!.payload,
            signature: proofMaterialised!.signature,
            state_init: proofMaterialised!.state_init,
            public_key: wallet.account.publicKey ?? undefined,
          }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(body?.error ?? `verify HTTP ${r.status}`);
        }
        setPhase("ok");
        router.push(next);
        router.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase("error");
      }
    })();
  }, [wallet, phase, router, next]);

  async function submitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!passwordEnabled) return;
    setPwStatus("sending");
    setPwError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
      setPwStatus("ok");
      router.push(next);
      router.refresh();
    } catch (err) {
      setPwStatus("err");
      setPwError(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <div className="mt-6 space-y-6">
      {/* Wallet connect (primary) */}
      <div>
        <Button
          kind="ton"
          disabled={
            phase === "challenging" ||
            phase === "opening" ||
            phase === "verifying"
          }
          onClick={startWalletFlow}
          aria-label="Connect wallet to sign in"
          data-ton-connect-button
          className="w-full"
        >
          {phase === "challenging"
            ? "Preparing challenge…"
            : phase === "opening"
              ? "Awaiting wallet…"
              : phase === "verifying"
                ? "Verifying proof…"
                : "Connect wallet to sign in"}
        </Button>
        <p className="mt-2 text-[11px] text-fg-dim">
          TON Connect wallet — signs a single one-time-use nonce for this
          dashboard. No password required.
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-red">
            {error}
          </p>
        ) : null}
      </div>

      {/* Password fallback (only if env enabled) */}
      {passwordEnabled ? (
        <>
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border-strong" />
            <span className="text-[11px] uppercase tracking-wide text-fg-dim">
              or
            </span>
            <span className="h-px flex-1 bg-border-strong" />
          </div>

          <form onSubmit={submitPassword} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-fg-muted">
                Admin password (break-glass)
              </span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-border-strong bg-bg-elev px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-dim focus:border-teal"
              />
            </label>
            {pwError ? (
              <p role="alert" className="text-xs text-red">
                {pwError}
              </p>
            ) : null}
            <Button kind="neutral" type="submit" disabled={pwStatus === "sending"} className="w-full">
              {pwStatus === "sending" ? "Signing in…" : "Sign in with password"}
            </Button>
          </form>
        </>
      ) : (
        <p className="text-[11px] text-fg-dim">
          Password sign-in is disabled. Use the wallet button above.
        </p>
      )}
    </div>
  );
}
