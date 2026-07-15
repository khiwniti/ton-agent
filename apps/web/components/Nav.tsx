"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { truncateAddress } from "@/lib/format";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/chat", label: "Chat" },
  { href: "/radar", label: "Radar" },
  { href: "/settings", label: "Settings" },
];

/**
 * Header — primary nav + TON Connect wallet chip.
 *
 * The wallet chip shows a truncated address when Tonkeeper (or any supported
 * wallet) is connected. Disconnecting requires a server-side logout so the
 * session cookie clears; we also call `tonConnectUI.disconnect()` so the
 * WalletConnect session stops auto-reconnecting on reload.
 */
export function Nav({ email }: { email?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();

  const handleSignOut = useCallback(async () => {
    try {
      if (wallet) {
        await tonConnectUI.disconnect();
      }
    } catch {
      // Best-effort — wallet may already be gone.
    }
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }, [tonConnectUI, wallet, router]);

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg-elev/90 backdrop-blur">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-14 max-w-7xl items-center gap-1 px-4"
      >
        <Link
          href="/dashboard"
          className="mr-4 flex items-center gap-2 font-semibold tracking-tight"
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full bg-teal shadow-[0_0_8px_var(--color-teal)]"
          />
          <span>TON Agent</span>
        </Link>

        <ul className="flex items-center gap-1">
          {LINKS.map((l) => {
            const active =
              pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-panel text-fg"
                      : "text-fg-muted hover:bg-panel hover:text-fg"
                  }`}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="ml-auto flex items-center gap-3">
          {wallet ? (
            <Link
              href={`https://tonviewer.com/${wallet.account.address}`}
              target="_blank"
              rel="noreferrer"
              className="mono hidden rounded-md border border-teal/40 bg-teal/10 px-2 py-1 text-xs text-teal transition-colors hover:bg-teal/15 sm:inline"
              title={wallet.account.address}
            >
              {truncateAddress(wallet.account.address, 6, 4)}
            </Link>
          ) : email ? (
            <span className="hidden text-xs text-fg-dim sm:inline mono">
              {email}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-muted transition-colors hover:border-red/50 hover:text-red"
          >
            Sign out
          </button>
        </div>
      </nav>
    </header>
  );
}
