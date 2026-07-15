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
 *
 * IMPORTANT — walletsList / includeWallets:
 *   Without a restricted wallets list, the SDK probes ALL bridges from
 *   the default wallets registry on every page load for wallet-discovery.
 *   Many of these bridges are blocked by CSP or have DNS failures on
 *   certain networks, which leaves the connection stuck on "Awaiting
 *   wallet".  By providing an explicit walletsList we limit the SDK to
 *   only the bridge(s) we know work and have whitelisted in our CSP
 *   connect-src.
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

  // Restrict the wallets list to keep the SDK from probing bridges that
  // get CSP-blocked. MyTonWallet uses its own bridge; the universal flow
  // defaults to Tonkeeper's bridge. Both are whitelisted in the CSP.
  const restrictedWallets = [
    {
      name: "Tonkeeper",
      imageUrl: "https://tonkeeper.com/assets/tonconnect-icon.png",
      aboutUrl: "https://tonkeeper.com",
      bridgeUrl: "https://bridge.tonapi.io",
      universalLink: "https://app.tonkeeper.com/ton-connect",
    },
    {
      name: "MyTonWallet",
      imageUrl: "https://mytonwallet.io/icon-192.png",
      aboutUrl: "https://mytonwallet.io",
      bridgeUrl: "https://tonconnectbridge.mytonwallet.org/bridge/",
      // Official universal link (opens the mobile app via TON Connect QR code)
      universalLink: "https://connect.mytonwallet.org",
      // MyTonWallet also supports the custom scheme: mytonwallet-tc://
      jsBridgeKey: "mytonwallet",
    },
  ];

  // v2.4.4's provider types don't always include bridgeUrl/preferences.
  // Cast to `any` so the runtime is correct while the type surface stabilises.
  const providerProps = {
    manifestUrl,
    // Universal connection QR code uses this bridge. Bare domain — the
    // SDK appends the path it needs (e.g. /bridge/events).
    bridgeUrl: "https://bridge.tonapi.io",
    walletsList: restrictedWallets,
    preferences: { theme: "DARK" },
  } as any;

  return (
    <TonConnectUIProvider {...providerProps}>
      {children}
    </TonConnectUIProvider>
  );
}
