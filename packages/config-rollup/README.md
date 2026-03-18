# @arcaai/config-rollup

Shared Rollup build configuration for the HOPE monorepo, providing a base configuration for bundling TypeScript packages.

## Overview

This package provides a reusable Rollup configuration factory used by frontend packages in the HOPE monorepo. It includes TypeScript compilation, Babel transpilation, minification, code obfuscation, and various Rollup plugins for handling CommonJS modules, JSON files, and Node.js built-ins.

## Usage

Import and extend the base configuration in your package's `rollup.config.js`:

```javascript
import { createConfig } from '@arcaai/config-rollup';

export default createConfig({
  input: 'src/index.ts',
  output: { dir: 'dist' },
});
```

## Included Plugins

- `rollup-plugin-typescript2` - TypeScript compilation
- `@rollup/plugin-babel` - Babel transpilation
- `rollup-plugin-terser` - Code minification
- `rollup-plugin-obfuscator` - Code obfuscation
- `@rollup/plugin-commonjs` - CommonJS module support
- `@rollup/plugin-node-resolve` - Node.js module resolution
- `@rollup/plugin-json` - JSON file importing
- `@rollup/plugin-replace` - Environment variable replacement

## License

MIT
