import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(600px 300px at 20% -10%, rgba(45,212,191,0.15), transparent), radial-gradient(500px 300px at 90% 10%, rgba(245,158,11,0.10), transparent)",
        }}
      />

      <header className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-2 font-semibold">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full bg-teal shadow-[0_0_8px_var(--color-teal)]"
          />
          TON Agent
        </div>
        <Link
          href="/login"
          className="rounded-md border border-border-strong px-4 py-1.5 text-sm text-fg-muted transition-colors hover:border-teal/50 hover:text-teal"
        >
          Sign in
        </Link>
      </header>

      <main className="relative mx-auto max-w-4xl px-6 pt-24 pb-16 text-center">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border-strong bg-panel px-3 py-1 text-xs text-fg-muted mono">
          <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden />
          Autonomous · 24/7 · Multi-tier
        </p>
        <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          Control plane for a{" "}
          <span className="text-teal">TON autonomous trading agent</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-fg-muted">
          A headless ReAct agent scouts new jettons on Ston.fi and DeDust,
          audits them for safety, and trades across three risk-tier wallets —{" "}
          <span className="text-teal">LOW</span>,{" "}
          <span className="text-amber">MID</span>, and{" "}
          <span className="text-red">HIGH</span>. This dashboard streams every
          decision live and gives you a one-tap kill switch.
        </p>

        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-teal px-6 py-3 font-medium text-bg transition-transform hover:scale-[1.02]"
          >
            Open dashboard
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-border-strong px-6 py-3 font-medium text-fg-muted transition-colors hover:text-fg"
          >
            Magic-link sign in
          </Link>
        </div>

        <ul className="mx-auto mt-16 grid max-w-3xl grid-cols-1 gap-4 text-left sm:grid-cols-3">
          {[
            {
              t: "Live radar",
              d: "Realtime feed of every jetton the agent evaluates, with safety badges.",
            },
            {
              t: "ReAct timeline",
              d: "See the agent's reasoning, tool calls, and results as they happen.",
            },
            {
              t: "Kill switch",
              d: "Halt all tiers instantly. The agent polls and stops trading.",
            },
          ].map((f) => (
            <li
              key={f.t}
              className="rounded-xl border border-border bg-panel/60 p-4"
            >
              <h3 className="font-medium text-fg">{f.t}</h3>
              <p className="mt-1 text-sm text-fg-muted">{f.d}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="relative mx-auto max-w-6xl px-6 py-8 text-center text-xs text-fg-dim">
        Trades real assets. Not financial advice. Use at your own risk.
      </footer>
    </div>
  );
}
