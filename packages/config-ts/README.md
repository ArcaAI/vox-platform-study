# @arcaai/config-ts — shared TypeScript compiler presets

Shared TypeScript compiler configurations for the HOPE monorepo. Every app and TypeScript package
extends one of these JSON presets from its `tsconfig.json`, keeping strictness, module resolution,
and emit settings consistent.

## Layout

| Path | What it holds |
|---|---|
| `base.json` | `strict`, `module`/`moduleResolution` NodeNext, declarations + maps, `isolatedModules`, `skipLibCheck` |
| `nestjs.json` | Extends base; CommonJS, ES2021, decorators + metadata, relaxed strictness (`noImplicitAny`/`strictNullChecks` off), incremental |
| `react-library.json` | Extends base; `jsx: react-jsx`, ES6 target |
| `nextjs.json` | Extends base; Next.js plugin, `jsx: preserve`, bundler resolution, `noEmit` |
| `vite.json` | Extends base; ESNext, `jsx: react`, `types: ["vite/client"]`, `noEmit` |

## How it works

### Current consumers (verified against tsconfig.json `extends`)

| Preset | Consumers |
|---|---|
| `base.json` | root `tsconfig.json`, `packages/database`, `exceptions`, `logger`, `pipeline`, `types`, `utils`, `stt`, `room`, `vox-node`, `vox-codegen`, `vox-node-codegen`, `workflow-contract`, `json-schema-subset`, `async-contract` |
| `nestjs.json` | `apps/api`, `packages/applications`, `packages/domains` |
| `react-library.json` | `packages/agentic-sdk-v2`, `config-tailwind`, `med-ner`, `noise-filter`, `ui`, `vad` |
| `nextjs.json` | `apps/admin-console` |
| `vite.json` | none currently |

### Usage

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

Pick the preset that matches the target: plain Node/TS library -> `base.json`, NestJS backend code
-> `nestjs.json`, React library -> `react-library.json`, Next.js app -> `nextjs.json`. Consumers add
only project-specific options (paths, `outDir`, `include`/`exclude`) on top.

## Related

- [`13-nextjs-apps.md`](../../.claude/rules/13-nextjs-apps.md) — `apps/admin-console`'s use of `nextjs.json`
- [`07-react-ui.md`](../../.claude/rules/07-react-ui.md) — React/shadcn package conventions
