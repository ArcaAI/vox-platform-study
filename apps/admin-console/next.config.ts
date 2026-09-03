import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { config as loadDotenv } from 'dotenv';

// Repo env convention (.env.sample header): local development loads the
// monorepo-root .env.dev; CI and production load NO env file (host env only).
// Host environment variables keep priority (dotenv never overrides set keys).
if (process.env.NODE_ENV === 'development' && !process.env.CI) {
  const envFile = resolve(process.cwd(), '../../.env.dev');
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, override: false, quiet: true });
  }
}

const nextConfig: NextConfig = {
  // baseline security headers on every response (pages, route
  // handlers, and the BFF proxy at /api/hope/[...path] alike — Next applies
  // config-level `headers()` at the routing layer ahead of rendering, so it
  // covers the App Router and Route Handlers the same way).
  //
  // `frame-ancestors 'self'` (NOT 'none', NOT X-Frame-Options: DENY) is
  // deliberate: the Database Studio screen
  // (src/features/db-studio/components/db-studio-screen.tsx) embeds
  // `/api/hope/admin/pstudio` — same-origin, proxied by this app's own
  // src/app/api/hope/[...path]/route.ts — in a same-origin <iframe>. That
  // proxy response also carries this header (no exemption below), so both
  // the framing page and the framed content assert "same-origin embedding
  // only", and 'self' is exactly what permits that self-embed. `'none'` or
  // `DENY` would break the studio embed outright.
  //
  // X-Frame-Options: SAMEORIGIN rides alongside frame-ancestors as a legacy
  // fallback for the small slice of clients that honor X-Frame-Options but
  // not CSP3 frame-ancestors — SAMEORIGIN is the exact behavioral analog of
  // 'self' (same-origin framing only), so it cannot be stricter than the CSP
  // directive and cannot break the db-studio embed either.
  //
  // No script-src/style-src here on purpose — a real CSP needs nonce
  // plumbing through the App Router render path, which is out of scope for
  // this fix ( for the follow-up recommendation).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  // @arcaai/ui ships raw TSX through its "./*" export (rule 13).
  transpilePackages: ['@arcaai/ui'],
  experimental: {
    // The @arcaai/ui root barrel re-exports the entire catalog (incl. heavy
    // registries); rewrite barrel imports to direct ones so a screen only
    // compiles/bundles the components it uses.
    optimizePackageImports: ['@arcaai/ui'],
  },
  output: 'standalone',
  // `next build` traces the files the server will need by following STATIC
  // requires. Next's own `dist/server/require-hook.js` loads the swc helpers
  // through the wildcard subpath export `"./esm/*": "./esm/*"`, which no static
  // tracer can enumerate — so standalone shipped exactly 3 of the package's
  // files (cjs/_interop_require_default.cjs, cjs/_interop_require_wildcard.cjs,
  // package.json) and none of the 108 under esm/. The container then died at
  // boot on `Cannot find module '.../@swc/helpers/esm/_interop_require_default.js'`
  // (dev-1c410d31, 786 restarts). Force-include the whole package; it is 1.8 MB.
  //
  // Scope is deliberately `@swc/helpers/**` and NOT the whole `.pnpm` entry.
  // Widening it to `@swc+helpers@*/node_modules/**` makes the glob match the
  // sibling `tslib` symlink, which Turbopack then tries to read as a file and
  // dies: `reading file ".../@swc+helpers@0.5.23/node_modules/tslib" - Is a
  // directory (os error 21)`. Verified — that widening fails the build.
  //
  // KNOWN RESIDUAL: 7 of the 108 helpers (`_ts_decorate`, `_ts_metadata`,
  // `_ts_param`, `_ts_values`, `_ts_dispose_resources`,
  // `_ts_add_disposable_resource`, `_ts_rewrite_relative_import_extension`)
  // `import ... from 'tslib'`, and tslib is not traced into the output. They are
  // the TypeScript decorator/`using` helpers; this app emits neither, and the
  // observed crash was `_interop_require_default` only. Copying tslib in would
  // NOT fix it regardless — resolution runs through that same sibling symlink,
  // so the package would ship unreachable. If a `_ts_*` helper ever appears in a
  // MODULE_NOT_FOUND here, the fix is a real dependency on tslib in this app's
  // package.json, not a wider glob.
  //
  // Globs are relative to this project directory. The tracing root stays
  // INFERRED (the pnpm-lock at the monorepo root): the standalone layout it
  // produces is what `CMD ["node", "apps/admin-console/server.js"]` expects, so
  // pinning outputFileTracingRoot here would risk moving server.js.
  outputFileTracingIncludes: {
    '/**/*': ['../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**'],
  },
};

export default nextConfig;
