"use client";

/**
 * Top-level error boundary for the routed web app. Replaces Next's default
 * production error page (which would otherwise render a generic message but
 * can leak stack traces via console). Always renders + minimal UI so an
 * unhandled error never shows the raw Next.js error overlay in prod.
 *
 * Place at `app/global-error.tsx` (this file). The `app/error.tsx` boundary
 * handles normal route errors; `global-error.tsx` is the last-resort catch.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#07090c",
          color: "#e6edf3",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            padding: 32,
            borderRadius: 16,
            border: "1px solid #1e2630",
            background: "#11161d",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p
            style={{
              marginTop: 8,
              fontSize: 14,
              color: "#8b98a5",
              lineHeight: 1.5,
            }}
          >
            The control plane hit an unexpected error. Reload to retry — your
            session is unchanged.
          </p>
          {error.digest ? (
            <p
              style={{
                marginTop: 12,
                fontSize: 12,
                color: "#5c6773",
                fontFamily: "ui-monospace, 'SF Mono', monospace",
              }}
            >
              ref · {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "#2dd4bf",
              color: "#07090c",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
