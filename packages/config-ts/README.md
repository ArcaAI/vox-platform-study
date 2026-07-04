# @arcaai/config-ts

Shared TypeScript compiler configurations for the HOPE monorepo. Every app and TypeScript package extends one of these JSON presets from its `tsconfig.json`, keeping strictness, module resolution, and emit settings consistent.

Last updated: 2026-07-04

## Available Presets

| File | Highlights | Current consumers (verified) |
|---|---|---|
| `base.json` | `strict`, `module`/`moduleResolution` NodeNext, declarations + maps, `isolatedModules`, `skipLibCheck` | root `tsconfig.json`, `packages/database`, `exceptions`, `logger`, `pipeline`, `room`, `types`, `utils` |
| `nestjs.json` | extends base; CommonJS, ES2021, decorators + metadata, relaxed strictness (`noImplicitAny`/`strictNullChecks` off), incremental | `apps/api`, `packages/applications`, `packages/domains` |
| `react-library.json` | extends base; `jsx: react-jsx`, ES6 target | `packages/agentic-sdk-v2`, `config-tailwind`, `med-ner`, `noise-filter`, `ui`, `vad` |
| `nextjs.json` | extends base; Next.js plugin, `jsx: preserve`, bundler resolution, `noEmit` | none currently |
| `vite.json` | extends base; ESNext, `jsx: react`, `types: ["vite/client"]`, `noEmit` | none currently |

## Usage

Extend a preset by package subpath — real example from `apps/api/tsconfig.json` (abridged):

```json
{
  "extends": "@arcaai/config-ts/nestjs.json",
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

And from `packages/ui/tsconfig.json`:

```json
{
  "extends": "@arcaai/config-ts/react-library.json"
}
```

Pick the preset that matches the target: plain Node/TS library → `base.json`, NestJS backend code → `nestjs.json`, React library → `react-library.json`. Consumers add only project-specific options (paths, `outDir`, `include`/`exclude`) on top.

License: MIT (per package.json).
