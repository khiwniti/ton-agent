/**
 * Ambient CSS module declarations so `tsc --noEmit` passes on the Next 15
 * web app without invoking `next dev`/`next build` first.
 *
 * Next's own compiler pipeline understands `import "./globals.css"` because
 * it bundles through webpack/turbopack. Bare `tsc` does not — and Next no
 * longer auto-injects a CSS shim into next-env.d.ts. We restore the shim
 * here so CI's `tsc --noEmit` step stays green.
 */
declare module "*.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module "*.css";
declare module "*.scss";
