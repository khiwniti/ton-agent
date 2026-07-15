"use client";

/**
 * Client-component wrapper around @tonconnect/ui-react's TonConnectUIProvider.
 *
 * Why a separate file? The SDK touches `window` and `localStorage`, so it
 * would crash a Server Component render. Mounting it inside a "use client"
 * boundary keeps it lazy-loaded on the browser only.
 *
 * Wallet discovery strategy:
 *   The TON Connect SDK fetches wallets-v2.json from the public registry to
 *   populate the wallet picker. This includes bridges that may be unreachable
 *   from certain networks (DNS or CSP blocks). We handle this by:
 *
 *   1. Setting `manifestUrl` explicitly — required for the ton_proof flow.
 *   2. Using `walletsRequiredFeatures` to filter wallet discovery to only
 *      wallets that support ALL listed features (including ton_proof auth).
 *      This prevents the SDK from instantly probing bridges that don't match
 *      our requirements.
 *   3. NOT using `walletsListConfiguration.includeWallets` — per the SDK docs,
 *      this only ADDS wallets on top of the default registry; it does NOT
 *      replace or restrict it. Using it alone wouldn't stop registry probes.
 *
 * The TON Connect manifest file (tonconnect-manifest.json) controls the
 * bridge URL used for QR-code-based universal connections. Keep that file
 * in sync with the deployed domain.
 *
 * @see https://docs.ton.org/applications/ton-connect/api-reference/ui-react
 */
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import type { ReactNode } from "react";

const DEFAULT_APP_URL =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_APP_URL || "https://ton-agent-rho.vercel.app"
    : "https://ton-agent-rho.vercel.app";

/**
 * Features we require wallets to support.
 *
 * `tonProof` is essential — our auth flow relies on proof-of-ownership.
 * Without it, the wallet cannot participate in the sign-in flow and
 * should be hidden from the picker (or sorted below a separator).
 */
const REQUIRED_WALLET_FEATURES = ["tonProof"];

export function TonConnectProvider({ children }: { children: ReactNode }) {
  const manifestUrl =
    process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL ||
    `${DEFAULT_APP_URL.replace(/\/$/, "")}/tonconnect-manifest.json`;

  const providerProps = {
    manifestUrl,
    walletsRequiredFeatures: REQUIRED_WALLET_FEATURES,
    uiPreferences: { theme: "DARK" as const },
    // Explicitly restore connection on mount so returning users don't
    // need to re-scan a QR code.
    restoreConnection: true,
  } as any;

  return (
    <TonConnectUIProvider {...providerProps}>
      {children}
    </TonConnectUIProvider>
  );
}
