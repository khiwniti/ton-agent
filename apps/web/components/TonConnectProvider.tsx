"use client";

/**
 * Client-component wrapper around @tonconnect/ui-react's TonConnectUIProvider.
 *
 * Why a separate file? The SDK touches `window` and `localStorage`, so it
 * would crash a Server Component render. Mounting it inside a "use client"
 * boundary keeps it lazy-loaded on the browser only.
 *
 * IMPORTANT — walletsListConfiguration / walletsListSource:
 *   Without a restricted wallets list, the SDK fetches the DEFAULT wallet
 *   registry from https://wallet.ton.org/wallets.json on every page load,
 *   then probes EVERY bridge in the registry for wallet-discovery.  Many
 *   of those bridges are blocked by CSP or have DNS failures on certain
 *   networks, which leaves the connection stuck on "Awaiting wallet".
 *   By providing an explicit walletsListSource (pointing to our manifest)
 *   and includeWallets we LIMIT the SDK to only the wallet(s) we know
 *   work and have whitelisted in our CSP connect-src.
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

  // Hard-restrict the wallet list to ONLY the bridges we've whitelisted
  // in the CSP.  By pointing walletsListSource at our own manifest URL
  // the SDK will NOT fetch the default wallet registry, which eliminates
  // the CSP-blocked bridge probes that were causing the "awaiting wallet"
  // deadlock.
  const options = {
    manifestUrl,
    // Universal connection QR code uses this bridge. Bare domain — the
    // SDK appends the path it needs (e.g. /bridge/events).
    bridgeUrl: "https://bridge.tonapi.io",
    walletsListConfiguration: {
      // Point to our own manifest so the SDK skips the default registry
      walletsListSource: manifestUrl,
      includeWallets: [
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
          universalLink: "https://connect.mytonwallet.org",
          jsBridgeKey: "mytonwallet",
        },
      ],
    },
    preferences: { theme: "DARK" },
  } as any;

  return (
    <TonConnectUIProvider options={options}>
      {children}
    </TonConnectUIProvider>
  );
}
