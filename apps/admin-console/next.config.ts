import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { config as loadDotenv } from 'dotenv';

// Repo env convention (.env.example header): local development loads the
// monorepo-root .env.dev; CI and production load NO env file (host env only).
// Host environment variables keep priority (dotenv never overrides set keys).
if (process.env.NODE_ENV === 'development' && !process.env.CI) {
    const envFile = resolve(process.cwd(), '../../.env.dev');
    if (existsSync(envFile)) {
        loadDotenv({ path: envFile, override: false, quiet: true });
    }
}

const nextConfig: NextConfig = {
    // @arcaai/ui ships raw TSX through its "./*" export (rule 13).
    transpilePackages: ['@arcaai/ui'],
    experimental: {
        // The @arcaai/ui root barrel re-exports the entire catalog (incl. heavy
        // registries); rewrite barrel imports to direct ones so a screen only
        // compiles/bundles the components it uses.
        optimizePackageImports: ['@arcaai/ui'],
    },
    output: 'standalone',
};

export default nextConfig;
