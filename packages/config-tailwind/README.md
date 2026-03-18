# @arcaai/config-tailwind

Shared Tailwind CSS configuration for the HOPE monorepo, providing a consistent design system foundation across all frontend applications.

## Overview

This package exports a base Tailwind CSS configuration that can be extended by frontend applications in the HOPE monorepo. It ensures consistent styling, color palettes, spacing scales, and responsive breakpoints across the admin dashboard and other UI applications.

## Usage

Import and extend the base configuration in your application's Tailwind config:

```typescript
import baseConfig from '@arcaai/config-tailwind';

export default {
  ...baseConfig,
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};
```

## Dependencies

- `tailwindcss` ^4.x

## License

MIT
