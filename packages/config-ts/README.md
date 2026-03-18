# @arcaai/config-ts

Shared TypeScript configuration package for the HOPE monorepo, providing base `tsconfig.json` files from which all other TypeScript configurations inherit.

## Overview

This package contains the foundational TypeScript compiler configurations used across the entire HOPE monorepo. It ensures consistent TypeScript settings, strict type checking, and compatible module resolution across all apps and packages.

## Usage

Extend the base configuration in your project's `tsconfig.json`:

```json
{
  "extends": "@arcaai/config-ts/base.json"
}
```

## License

MIT
