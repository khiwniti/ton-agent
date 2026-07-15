import Link from "next/link";

export const metadata = { title: "Not found · TON Agent" };

/**
 * 404 boundary. Branded so it matches the rest of the control plane rather
 * than Next.js's default chrome.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="text-xs text-fg-dim mono">404</p>
      <h1 className="mt-2 text-xl font-semibold text-fg">Page not found</h1>
      <p className="mt-2 text-sm text-fg-muted">
        That route doesn&apos;t exist in the control plane. Hit the dashboard
        to pick a section.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 rounded-lg bg-teal px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-teal/90"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
