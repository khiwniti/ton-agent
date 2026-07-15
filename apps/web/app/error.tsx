"use client";

import Link from "next/link";

/**
 * Route-segment error boundary. Renders inside any child segment that throws
 * (caught by Next 15's error boundary). Shows a recoverable error card; the
 * reset() button retries the segment.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <h1 className="text-lg font-semibold text-fg">
        Couldn&apos;t load this page
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        The control plane hit an unexpected error. You can retry, or head back
        to the dashboard.
      </p>
      {error.digest ? (
        <p className="mt-3 text-xs text-fg-dim mono">ref · {error.digest}</p>
      ) : null}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-teal px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-teal/90"
        >
          Retry
        </button>
        <Link
          href="/dashboard"
          className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
