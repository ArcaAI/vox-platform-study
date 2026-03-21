# @arcaai/utils

Shared utility functions and services for the HOPE platform, providing common helpers for date manipulation, formatting, validation, and model management.

## Overview

The `@arcaai/utils` package provides reusable utility functions used across HOPE frontend applications and packages. It includes date formatting, string manipulation, input validation, and a comprehensive model management system for downloading, caching, and loading machine learning models in the browser.

## Features

- **Date Utilities** - Date formatting and manipulation helpers
- **Format Utilities** - String and data formatting functions
- **Validation Utilities** - Input validation and sanitization
- **Model Management** - Browser-based ML model lifecycle management
  - `ModelDownloader` - Download models from remote sources
  - `ModelManagementService` - Orchestrate model availability and updates
  - `ModelLoader` - Load models into runtime (ONNX, Transformers.js)
  - `ModelSourceManager` - Manage multiple model sources and registries
  - `ModelRegistry` - Track available models and their metadata
  - Transformers.js cache integration

## Installation

```bash
pnpm add @arcaai/utils
```

## Usage

```typescript
import { formatDate, validateEmail, ModelDownloader } from '@arcaai/utils';
```

## Dependencies

- `@arcaai/types` - Shared TypeScript type definitions

## License

MIT
