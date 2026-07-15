"use client";

/**
 * Client-component wrapper around @tonconnect/ui-react's TonConnectUIProvider.
 *
 * Why a separate file? The SDK touches `window` and `localStorage`, so it
 * would crash a Server Component render. Mounting it inside a "use client"
 * boundary keeps it lazy-loaded on the browser only.
 *
 * v2.4.4 of `@tonconnect/ui-react` accepts the manifest URL on the provider.
 * The bridge URL is derived from the SDK's manifest JSON (via `bridge`
 * field). Override either via NEXT_PUBLIC_TONCONNECT_MANIFEST_URL or by
 * adding a `bridge` field to public/tonconnect-manifest.json.
 *
 * Manifest URL defaults to ${NEXT_PUBLIC_APP_URL}/tonconnect-manifest.json
 * if no explicit override is set.
 */
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import type { ReactNode } from "react";

const DEFAULT_APP_URL =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_APP_URL || ""
    : "";

export function TonConnectProvider({ children }: { children: ReactNode }) {
  const manifestUrl =
    process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL ||
    `${DEFAULT_APP_URL.replace(/\/$/, "")}/tonconnect-manifest.json`;

  // Explicit bridge URL ensures the QR-code (universal) flow uses a bridge
  // that's already in our CSP connect-src. Without this, the SDK probes
  // every registered wallet bridge and gets blocked by CSP for the ones
  // we haven't whitelisted, leaving the user stuck on "Awaiting wallet".
  //
  // Tonkeeper's bridge is the most reliable and already whitelisted.
  // v2.4.4's provider types don't always include bridgeUrl/preferences.
  // Cast to `any` so the runtime is correct while the type surface stabilises.
  const providerProps = {
    manifestUrl,
    bridgeUrl: "https://bridge.tonapi.io/bridge",
    preferences: { theme: "DARK" },
  } as any;

  return (
    <TonConnectUIProvider {...providerProps}>
      {children}
    </TonConnectUIProvider>
  );
}
