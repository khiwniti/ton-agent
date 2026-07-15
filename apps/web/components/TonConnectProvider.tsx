"use client";

/**
 * Client-component wrapper around @tonconnect/ui-react's TonConnectUIProvider.
 *
 * Why a separate file? The SDK touches `window` and `localStorage`, so it
 * would crash a Server Component render. Mounting it inside a "use client"
 * boundary keeps it lazy-loaded on the browser only.
 *
 * IMPORTANT — walletsListConfiguration:
 *   Without a restricted wallets list, the SDK probes ALL bridges from the
 *   default wallet registry (fetched from wallet.ton.org) for wallet-discovery
 *   on every page load.  Many of those bridges are blocked by CSP or have DNS
 *   failures on certain networks, which leaves connections stuck on "Awaiting
 *   wallet".  By providing an explicit includeWallets list we ensure our two
 *   preferred wallets (Tonkeeper + MyTonWallet) are present and discoverable,
 *   even if the default registry probes still fire in the background.
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

  // v2.4.4 — TonConnectUIProvider accepts direct props.
  // walletsListConfiguration.includeWallets adds wallets on top of the
  // default registry; we cast to any because extra fields like jsBridgeKey
  // are not in the v2.4.4 type surface but are recognised at runtime.
  const providerProps = {
    manifestUrl,
    walletsListConfiguration: {
      includeWallets: [
        {
          name: "Tonkeeper",
          appName: "tonkeeper",
          imageUrl: "https://tonkeeper.com/assets/tonconnect-icon.png",
          aboutUrl: "https://tonkeeper.com",
          bridgeUrl: "https://bridge.tonapi.io",
          universalLink: "https://app.tonkeeper.com/ton-connect",
        },
        {
          name: "MyTonWallet",
          appName: "mytonwallet",
          imageUrl: "https://mytonwallet.io/icon-192.png",
          aboutUrl: "https://mytonwallet.io",
          bridgeUrl: "https://tonconnectbridge.mytonwallet.org/bridge/",
          universalLink: "https://connect.mytonwallet.org",
          // jsBridgeKey tells the SDK to check window.mytonwallet for the
          // browser extension's JS Bridge (extension detection).
          jsBridgeKey: "mytonwallet",
        },
      ],
    },
    uiPreferences: { theme: "DARK" },
  } as any;

  return (
    <TonConnectUIProvider {...providerProps}>
      {children}
    </TonConnectUIProvider>
  );
}
