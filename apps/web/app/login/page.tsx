import { Suspense } from "react";
import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { KillBanner } from "./KillBanner";

export const metadata = { title: "Sign in · TON Agent" };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-2 font-semibold"
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full bg-teal shadow-[0_0_8px_var(--color-teal)]"
          />
          TON Agent
        </Link>

        <div className="rounded-2xl border border-border bg-panel p-6 shadow-2xl">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Connect your official TON wallet to authenticate. The dashboard
            only accepts the single wallet address configured by the
            operator (Tonkeeper / OpenMask / MyTonWallet supported).
          </p>
          <Suspense
            fallback={
              <div className="mt-6 h-24 animate-pulse rounded-lg bg-bg-elev" />
            }
          >
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-fg-dim">
          Access is restricted. The agent&apos;s three tier wallets trade
          autonomously — this dashboard is for the operator only.
        </p>

        <KillBanner />
      </div>
    </div>
  );
}
