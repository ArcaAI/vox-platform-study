# @arcaai/applications

Shared application service layer for the HOPE platform, providing reusable NestJS services and business logic consumed by the API Gateway and other backend applications.

## Overview

The `@arcaai/applications` package contains the application service layer following clean architecture principles. It provides base services, domain-specific services, decorators, and authorization utilities that are shared across HOPE backend applications.

## Structure

- `common/` - Shared base services and utilities
- `decorators/` - Custom NestJS decorators
- `interfaces/` - Service interface definitions
- `services/` - Domain-specific service implementations
  - `base/` - Foundation services (logging, Redis, storage/S3)
  - `consultation/` - Medical consultation lifecycle services
  - `stt/` - Speech-to-text integration services
  - `user/` - User management and profile services
  - `dna-writing-style/` - Clinical writing style analysis services
  - `prompt-management/` - Prompt versioning and retrieval services
- `authorization/` - Role-based access control and policy enforcement

## Usage

```typescript
import { ConsultationService, UserService } from '@arcaai/applications';
```

## Dependencies

- `@arcaai/domains` - Domain entities and repositories
- `@arcaai/database` - Prisma database client
- `@arcaai/logger` - Logging utilities
- `@arcaai/exceptions` - Exception types

## License

MIT
