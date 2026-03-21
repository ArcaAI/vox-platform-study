# @arcaai/exceptions

Standardized exception types for the HOPE platform, providing structured error handling across backend, domain, and common layers.

## Overview

The `@arcaai/exceptions` package defines a hierarchy of exception classes used throughout the HOPE backend services. It provides consistent error types for backend HTTP errors, domain validation errors, and common application errors, with NestJS Continuation Local Storage (CLS) integration for request-scoped error context.

## Structure

- `backend/` - Backend-specific exceptions (HTTP errors, service errors)
- `common/` - Common exceptions shared across layers
- `domain/` - Domain-level exceptions (validation, business rule violations)

## Usage

```typescript
import { NotFoundException, ValidationException } from '@arcaai/exceptions';

throw new NotFoundException('User not found');
throw new ValidationException('Invalid email format');
```

## Dependencies

- `nestjs-cls` - NestJS Continuation Local Storage for request context

## License

MIT
