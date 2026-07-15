import type { NextConfig } from "next";

/**
 * Server-rendered web app — own all the security headers we want Vercel to
 * send on every response. Most are belt-and-braces on top of Vercel's
 * defaults; CSP is the only one with non-trivial choices (see comments).
 */
const csp = [
  // Allow our own bundles only.
  "default-src 'self'",
  // Next.js ships inline hydration scripts + uses eval in some dev tooling.
  // For a strict prod CSP we'd switch to nonce-driven '<script>' tags, but
  // the workspace-time cost is high and means re-architecting page rendering.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // Tailwind injects inline styles for arbitrary classes.
  "style-src 'self' 'unsafe-inline'",
  // Splash + avatarp avatars often use data:; jetton icons from any HTTPS host.
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  // PostgREST + Realtime over Supabase subdomains.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://config.ton.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // 2y HSTS; only meaningful over HTTPS, which Vercel enforces.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The shared package ships raw TypeScript (main -> ./src/index.ts),
  // so Next must transpile it as part of the app build.
  transpilePackages: ["@ton-agent/shared"],
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
