# @arcaai/config-eslint

Shared ESLint configuration package for the HOPE monorepo, providing standardized linting rules for different project types.

## Overview

This package contains a collection of internal ESLint configurations tailored for the various project types in the HOPE monorepo. Each configuration extends a common base with rules specific to its target environment.

## Available Configurations

- **base** - Foundation rules shared by all projects
- **library** - Configuration for shared TypeScript library packages
- **nest** - Configuration for NestJS backend applications
- **next** - Configuration for Next.js frontend applications
- **react** - Configuration for React component libraries
- **storybook** - Configuration for Storybook stories

## Usage

Reference the appropriate configuration in your project's ESLint config:

```javascript
import { baseConfig } from '@arcaai/config-eslint/base';
```

## License

MIT
