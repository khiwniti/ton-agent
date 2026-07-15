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
    walletConnectedAt.current = null;
    try {
      // If a wallet is already connected from a previous session, disconnect
      // first so we can initiate a FRESH connection with the ton_proof challenge.
      // Without this, the SDK throws "Wallet connection called but wallet already
      // connected" and the proof flow never completes.
      if (wallet) {
        await tonConnectUI.disconnect();
        await new Promise((r) => setTimeout(r, 150)); // let SDK flush state
      }

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
   * Extract ton_proof from wallet.connectItems — handles both object form
   * (newer spec) and array form (older spec). Returns null if not present.
   */
  function extractProof(items: unknown): {
    payload: string;
    signature: string;
    state_init?: string;
  } | null {
    if (!items) return null;

    if (!Array.isArray(items) && typeof items === "object") {
      const tp = (items as { ton_proof?: unknown }).ton_proof;
      if (tp && typeof tp === "object") {
        const p = tp as { payload?: unknown; signature?: unknown; state_init?: unknown };
        if (typeof p.payload === "string" && typeof p.signature === "string") {
          return {
            payload: p.payload,
            signature: p.signature,
            state_init: typeof p.state_init === "string" ? p.state_init : undefined,
          };
        }
      }
    }

    if (Array.isArray(items)) {
      const tp = items.find((i: { type?: unknown }) => i?.type === "ton_proof") as
        | { payload?: unknown; signature?: unknown; state_init?: unknown }
        | undefined;
      if (
        tp &&
        typeof tp.payload === "string" &&
        typeof tp.signature === "string"
      ) {
        return {
          payload: tp.payload,
          signature: tp.signature,
          state_init: typeof tp.state_init === "string" ? tp.state_init : undefined,
        };
      }
    }

    return null;
  }

  /**
   * Timeout watchdog: after a wallet CONNECTS, we give PROOF_TIMEOUT_MS
   * for the connectItems.ton_proof to arrive (bridge event propagation
   * can lag behind the wallet object). If the timer expires, drop to
   * "stuck" with a recoverable message.
   */
  const walletConnectedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!wallet) {
      walletConnectedAt.current = null;
      return;
    }
    // Only start the timer once — first time wallet becomes truthy after opening.
    if (phase === "opening" && walletConnectedAt.current === null) {
      walletConnectedAt.current = Date.now();
    }

    // Check timeout.
    if (walletConnectedAt.current && phase !== "ok" && phase !== "idle") {
      const elapsed = Date.now() - walletConnectedAt.current;
      if (elapsed > PROOF_TIMEOUT_MS) {
        console.warn(
          "[LoginForm] proof timeout — wallet connected but connectItems.ton_proof never arrived. wallet=",
          wallet,
        );
        setError(
          "Connected wallet did not produce a proof signature. Some wallets (older OpenMask, certain Ledger flows) do not support TON Connect proof-of-ownership. Try Tonkeeper.",
        );
        setPhase("stuck");
        return;
      }
    }
  }, [wallet, phase]);

  /**
   * Proof detection with polling.
   *
   * When a wallet connects via the bridge (e.g. scanning a QR code), the
   * SDK sets the wallet object immediately, but the `connectItems` (which
   * contain the ton_proof signature) may arrive a few hundred milliseconds
   * later as bridge events propagate. We poll every 500ms for up to 15s to
   * catch late-arriving proofs.
   */
  const proofTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const MAX_POLLS = 30; // 30 × 500ms = 15 seconds

  // Cleanup interval on unmount.
  useEffect(() => {
    return () => {
      if (proofTimerRef.current) {
        clearInterval(proofTimerRef.current);
        proofTimerRef.current = null;
      }
    };
  }, []);

  /**
   * Keep a ref pointing to the latest wallet object so the polling
   * interval always reads the most current reference.  The SDK creates
   * a new wallet object when connectItems arrive (via bridge events);
   * without this ref the interval's closure would keep checking the
   * initial (pre-connectItems) object and never find the proof.
   */
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  // Wallet-connected → start polling for connectItems.
  useEffect(() => {
    // Guards: only start polling when wallet connects during opening phase.
    if (!wallet || phase !== "opening") {
      if (proofTimerRef.current) {
        clearInterval(proofTimerRef.current);
        proofTimerRef.current = null;
      }
      pollCountRef.current = 0;
      return;
    }

    // Already polling.
    if (proofTimerRef.current) return;

    if (process.env.NODE_ENV === "development") {
      console.log(
        "[LoginForm] wallet connected, polling for connectItems.ton_proof...",
        "hasConnectItems=",
        !!wallet.connectItems,
        "wallet keys:",
        Object.keys(wallet),
      );
    }

    proofTimerRef.current = setInterval(() => {
      pollCountRef.current++;

      // Use the ref so we always check the latest wallet object.
      const currentWallet = walletRef.current;
      const proof = extractProof(currentWallet?.connectItems);
      if (proof) {
        if (process.env.NODE_ENV === "development") {
          console.log(
            "[LoginForm] ton_proof found after",
            pollCountRef.current * 500,
            "ms",
          );
        }
        clearInterval(proofTimerRef.current!);
        proofTimerRef.current = null;
        pollCountRef.current = 0;

        // Fire the verify request (currentWallet is guaranteed non-null here
        // because we just read a proof from it above).
        void submitProof(proof, currentWallet!);
        return;
      }

      // Max polls reached — give up and trigger stuck state directly.
      if (pollCountRef.current >= MAX_POLLS) {
        if (process.env.NODE_ENV === "development") {
          console.warn(
            "[LoginForm] ton_proof never arrived after",
            MAX_POLLS * 500,
            "ms. connectItems=",
            currentWallet?.connectItems,
          );
        }
        clearInterval(proofTimerRef.current!);
        proofTimerRef.current = null;
        pollCountRef.current = 0;
        setPhase("stuck");
        setError(
          "Connected wallet did not produce a proof signature. Some wallets (older OpenMask, certain Ledger flows) do not support TON Connect proof-of-ownership. Try Tonkeeper.",
        );
      }
    }, 500);
  }, [wallet, phase]);

  async function submitProof(
    proof: { payload: string; signature: string; state_init?: string },
    w: NonNullable<ReturnType<typeof useTonWallet>>,
  ) {
    if (phase === "verifying" || phase === "ok") return;
    setPhase("verifying");
    setError(null);
    try {
      console.log("[LoginForm] POST /api/auth/wallet/verify address=",
        w.account?.address?.slice(0, 10) + "...");
      const r = await fetch("/api/auth/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet_address: w.account.address,
          payload: proof.payload,
          signature: proof.signature,
          state_init: proof.state_init,
          public_key: w.account.publicKey ?? undefined,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(body?.error ?? `verify HTTP ${r.status}`);
      }
      console.log("[LoginForm] verify OK, redirecting to", next);
      setPhase("ok");
      router.push(next);
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[LoginForm] verify failed:", msg);
      setError(msg);
      setPhase("error");
    }
  }

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
