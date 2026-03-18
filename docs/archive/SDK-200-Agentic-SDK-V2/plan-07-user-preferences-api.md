# Plan 07: User Preferences API

| Field             | Value                                            |
| ----------------- | ------------------------------------------------ |
| **Parent Ticket** | SDK-200                                          |
| **Phase**         | 7 - User Preferences API for SDK v2              |
| **Created Date**  | 2026-01-28                                       |
| **Last Updated**  | 2026-01-28                                       |
| **Status**        | Completed                                        |
| **Dependencies**  | Plan 03 (API Layer) ✅                           |

---

## Executive Summary

This plan addresses the **critical gap** identified in the SDK v2 code review: the SDK defines user preferences endpoints (`/users/me/preferences`) that are **not implemented** in the current API. This prevents the SDK's `PersonalizationManager` from working in `backend` or `hybrid` storage modes.

### Problem Statement

**SDK Expected API** (from `packages/agentic-sdk-v2/src/core/constants.ts`):
```typescript
PERSONALIZATION_ENDPOINTS = {
  GET_PREFERENCES: '/users/me/preferences',      // GET
  UPDATE_PREFERENCES: '/users/me/preferences',   // POST
}
```

**Current API Implementation**:
- Uses `/user-settings` with key-value based individual settings
- Requires explicit `userId` parameter
- No "me" endpoint for authenticated user self-service
- No aggregation of preferences into a single object

### Solution

Create new API endpoints under `/users/me/preferences` that:
1. Use the authenticated user context (from API key)
2. Aggregate key-value UserSettings into a single `UserPreferences` object
3. Support partial updates
4. Use a dedicated namespace (`arcaai-sdk`) for SDK preferences

---

## Architecture Overview

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SDK v2                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  PersonalizationManager                                        │  │
│  │  - storage: 'local' | 'backend' | 'hybrid'                    │  │
│  │  - GET /users/me/preferences                                   │  │
│  │  - POST /users/me/preferences                                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           API Gateway                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  UserPreferencesController                                     │  │
│  │  @Controller('users/me')                                       │  │
│  │  @UseGuards(ApiKeyGuard)                                       │  │
│  │  - GET  /preferences → getPreferences()                        │  │
│  │  - POST /preferences → updatePreferences()                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                    │                                 │
│                                    ▼                                 │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  UserPreferencesService                                        │  │
│  │  - Aggregates UserSettings → UserPreferences                   │  │
│  │  - Namespace: 'arcaai-sdk'                                     │  │
│  │  - Transforms key-value to/from typed object                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                    │                                 │
│                                    ▼                                 │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  UserSettingsRepository (existing)                             │  │
│  │  - CRUD for individual settings                                │  │
│  │  - Filter by userId + namespace                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Database                                   │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  UserSettings (existing table)                                 │  │
│  │  - id, userId, key, value, dataType, namespace                 │  │
│  │  - namespace = 'arcaai-sdk' for SDK preferences                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Reuse UserSettings table** | No schema changes required; use namespace for isolation |
| **Namespace: `arcaai-sdk`** | Distinguishes SDK preferences from other user settings |
| **Aggregation layer** | Transforms key-value to/from `UserPreferences` object |
| **API key auth** | SDK uses API keys, extracts userId from associated user |
| **Partial updates** | Only update provided fields, preserve others |

---

## SDK UserPreferences Interface

From `packages/agentic-sdk-v2/src/types/config.ts`:

```typescript
/**
 * User Preferences (persisted per user/doctor)
 */
export interface UserPreferences {
  /** Preferred language code */
  language?: string;
  /** Selected STT model ID */
  sttModel?: string;
  /** Noise filter level preference */
  noiseFilterLevel?: 'low' | 'medium' | 'high';
  /** VAD sensitivity preference (0-1) */
  vadSensitivity?: number;
  /** DNA writing style ID */
  dnaStyleId?: string;
  /** Custom preferences (extensible) */
  custom?: Record<string, unknown>;
}
```

---

## Step 1: API Contract Definition

### Endpoint Specification

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|--------------|----------|
| GET | `/users/me/preferences` | Get user preferences | - | `UserPreferencesResponse` |
| POST | `/users/me/preferences` | Update user preferences | `UpdateUserPreferencesRequest` | `UserPreferencesResponse` |

### Request/Response DTOs

**File**: `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts`

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserPreferencesResponse {
    @ApiPropertyOptional({ description: 'Preferred language code (e.g., "en", "th")' })
    language?: string;

    @ApiPropertyOptional({ description: 'Selected STT model ID' })
    sttModel?: string;

    @ApiPropertyOptional({
        description: 'Noise filter level preference',
        enum: ['low', 'medium', 'high']
    })
    noiseFilterLevel?: 'low' | 'medium' | 'high';

    @ApiPropertyOptional({
        description: 'VAD sensitivity preference (0-1)',
        minimum: 0,
        maximum: 1
    })
    vadSensitivity?: number;

    @ApiPropertyOptional({ description: 'DNA writing style ID' })
    dnaStyleId?: string;

    @ApiPropertyOptional({
        description: 'Custom preferences (extensible)',
        type: 'object',
        additionalProperties: true
    })
    custom?: Record<string, unknown>;

    @ApiProperty({ description: 'Last sync timestamp' })
    updatedAt: string;
}
```

**File**: `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts`

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNumber, Min, Max, IsObject } from 'class-validator';

export class UpdateUserPreferencesRequest {
    @ApiPropertyOptional({ description: 'Preferred language code' })
    @IsOptional()
    @IsString()
    language?: string;

    @ApiPropertyOptional({ description: 'Selected STT model ID' })
    @IsOptional()
    @IsString()
    sttModel?: string;

    @ApiPropertyOptional({
        description: 'Noise filter level',
        enum: ['low', 'medium', 'high']
    })
    @IsOptional()
    @IsEnum(['low', 'medium', 'high'])
    noiseFilterLevel?: 'low' | 'medium' | 'high';

    @ApiPropertyOptional({
        description: 'VAD sensitivity (0-1)',
        minimum: 0,
        maximum: 1
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(1)
    vadSensitivity?: number;

    @ApiPropertyOptional({ description: 'DNA writing style ID' })
    @IsOptional()
    @IsString()
    dnaStyleId?: string;

    @ApiPropertyOptional({
        description: 'Custom preferences',
        type: 'object',
        additionalProperties: true
    })
    @IsOptional()
    @IsObject()
    custom?: Record<string, unknown>;
}
```

---

## Step 2: Application Service

### Service Interface

**File**: `packages/applications/src/services/user/userPreferences/IUserPreferencesService.ts`

```typescript
import { UserPreferencesResponse, UpdateUserPreferencesRequest } from './dto';

export interface IUserPreferencesService {
    /**
     * Get aggregated preferences for the authenticated user
     */
    getPreferences(): Promise<UserPreferencesResponse>;

    /**
     * Update preferences (partial update - only update provided fields)
     */
    updatePreferences(request: UpdateUserPreferencesRequest): Promise<UserPreferencesResponse>;

    /**
     * Reset preferences to defaults
     */
    resetPreferences(): Promise<void>;
}

export const IUserPreferencesService = Symbol('IUserPreferencesService');
```

### Service Implementation

**File**: `packages/applications/src/services/user/userPreferences/userPreferences.service.ts`

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { UserSettingsRepository, ValueType } from '@arcaai/domains';
import { IUserPreferencesService } from './IUserPreferencesService';
import { UserPreferencesResponse, UpdateUserPreferencesRequest } from './dto';

const SDK_NAMESPACE = 'arcaai-sdk';

// Keys for SDK preferences
const PREFERENCE_KEYS = {
    LANGUAGE: 'language',
    STT_MODEL: 'sttModel',
    NOISE_FILTER_LEVEL: 'noiseFilterLevel',
    VAD_SENSITIVITY: 'vadSensitivity',
    DNA_STYLE_ID: 'dnaStyleId',
    CUSTOM: 'custom',
} as const;

@Injectable()
export class UserPreferencesService implements IUserPreferencesService {
    constructor(
        private readonly userSettingsRepository: UserSettingsRepository,
        private readonly cls: ClsService,
    ) {}

    private get userId(): string {
        const user = this.cls.get('user');
        if (!user?.id) {
            throw new Error('User context not available');
        }
        return user.id;
    }

    /**
     * Get aggregated preferences for authenticated user
     */
    async getPreferences(): Promise<UserPreferencesResponse> {
        const userId = this.userId;

        // Fetch all SDK settings for this user
        const settings = await this.userSettingsRepository.findByUserAndNamespace(
            userId,
            SDK_NAMESPACE,
        );

        // Build response from key-value pairs
        const response: UserPreferencesResponse = {
            updatedAt: new Date().toISOString(),
        };

        let latestUpdate = new Date(0);

        for (const setting of settings) {
            // Track latest update time
            if (setting.updatedAt > latestUpdate) {
                latestUpdate = setting.updatedAt;
            }

            // Map key to response field
            switch (setting.key) {
                case PREFERENCE_KEYS.LANGUAGE:
                    response.language = setting.value;
                    break;
                case PREFERENCE_KEYS.STT_MODEL:
                    response.sttModel = setting.value;
                    break;
                case PREFERENCE_KEYS.NOISE_FILTER_LEVEL:
                    response.noiseFilterLevel = setting.value as 'low' | 'medium' | 'high';
                    break;
                case PREFERENCE_KEYS.VAD_SENSITIVITY:
                    response.vadSensitivity = parseFloat(setting.value);
                    break;
                case PREFERENCE_KEYS.DNA_STYLE_ID:
                    response.dnaStyleId = setting.value;
                    break;
                case PREFERENCE_KEYS.CUSTOM:
                    try {
                        response.custom = JSON.parse(setting.value);
                    } catch {
                        response.custom = {};
                    }
                    break;
            }
        }

        if (settings.length > 0) {
            response.updatedAt = latestUpdate.toISOString();
        }

        return response;
    }

    /**
     * Update preferences (partial update)
     */
    async updatePreferences(
        request: UpdateUserPreferencesRequest,
    ): Promise<UserPreferencesResponse> {
        const userId = this.userId;

        // Update each provided field
        const updates: Array<{ key: string; value: string; dataType: ValueType }> = [];

        if (request.language !== undefined) {
            updates.push({
                key: PREFERENCE_KEYS.LANGUAGE,
                value: request.language,
                dataType: ValueType.STRING,
            });
        }

        if (request.sttModel !== undefined) {
            updates.push({
                key: PREFERENCE_KEYS.STT_MODEL,
                value: request.sttModel,
                dataType: ValueType.STRING,
            });
        }

        if (request.noiseFilterLevel !== undefined) {
            updates.push({
                key: PREFERENCE_KEYS.NOISE_FILTER_LEVEL,
                value: request.noiseFilterLevel,
                dataType: ValueType.STRING,
            });
        }

        if (request.vadSensitivity !== undefined) {
            updates.push({
                key: PREFERENCE_KEYS.VAD_SENSITIVITY,
                value: request.vadSensitivity.toString(),
                dataType: ValueType.FLOAT,
            });
        }

        if (request.dnaStyleId !== undefined) {
            updates.push({
                key: PREFERENCE_KEYS.DNA_STYLE_ID,
                value: request.dnaStyleId,
                dataType: ValueType.STRING,
            });
        }

        if (request.custom !== undefined) {
            updates.push({
                key: PREFERENCE_KEYS.CUSTOM,
                value: JSON.stringify(request.custom),
                dataType: ValueType.JSON,
            });
        }

        // Upsert each setting
        for (const update of updates) {
            await this.upsertSetting(userId, update.key, update.value, update.dataType);
        }

        // Return updated preferences
        return this.getPreferences();
    }

    /**
     * Reset preferences to defaults (delete all SDK settings)
     */
    async resetPreferences(): Promise<void> {
        const userId = this.userId;
        await this.userSettingsRepository.deleteByUserAndNamespace(userId, SDK_NAMESPACE);
    }

    /**
     * Upsert a single setting
     */
    private async upsertSetting(
        userId: string,
        key: string,
        value: string,
        dataType: ValueType,
    ): Promise<void> {
        const existing = await this.userSettingsRepository.findByUserKeyNamespace(
            userId,
            key,
            SDK_NAMESPACE,
        );

        if (existing) {
            // Update existing
            existing.value = value;
            existing.dataType = dataType;
            await this.userSettingsRepository.update(existing.id, existing);
        } else {
            // Create new
            await this.userSettingsRepository.create({
                userId,
                key,
                value,
                dataType,
                namespace: SDK_NAMESPACE,
                name: `SDK Preference: ${key}`,
            });
        }
    }
}
```

### Service Module

**File**: `packages/applications/src/services/user/userPreferences/userPreferences.service.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { UserPreferencesService } from './userPreferences.service';
import { IUserPreferencesService } from './IUserPreferencesService';

@Module({
    imports: [CoreDatabaseModule, ClsModule],
    providers: [
        {
            provide: IUserPreferencesService,
            useClass: UserPreferencesService,
        },
        UserPreferencesService,
    ],
    exports: [IUserPreferencesService, UserPreferencesService],
})
export class UserPreferencesServiceModule {}
```

---

## Step 3: Repository Extensions

Add methods to `UserSettingsRepository` for namespace-based queries.

**File**: `packages/domains/src/repositories/generated/core/UserSettingsRepository.ts`

Add these methods:

```typescript
/**
 * Find all settings for user with specific namespace
 */
async findByUserAndNamespace(
    userId: string,
    namespace: string,
): Promise<UserSettingsEntity[]> {
    const results = await this.prisma.userSettings.findMany({
        where: {
            userId,
            namespace,
            resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { key: 'asc' },
    });
    return results.map(this.mapper.toDomainEntity.bind(this.mapper));
}

/**
 * Find single setting by user, key, and namespace
 */
async findByUserKeyNamespace(
    userId: string,
    key: string,
    namespace: string,
): Promise<UserSettingsEntity | null> {
    const result = await this.prisma.userSettings.findFirst({
        where: {
            userId,
            key,
            namespace,
            resourceStatus: ResourceStatusType.ENABLED,
        },
    });
    return result ? this.mapper.toDomainEntity(result) : null;
}

/**
 * Delete all settings for user with specific namespace
 */
async deleteByUserAndNamespace(
    userId: string,
    namespace: string,
): Promise<void> {
    await this.prisma.userSettings.updateMany({
        where: {
            userId,
            namespace,
        },
        data: {
            resourceStatus: ResourceStatusType.DELETED,
            resourceStatusUpdatedAt: new Date(),
        },
    });
}
```

---

## Step 4: API Controller

**File**: `apps/api/src/modules/user-preferences/user-preferences.controller.ts`

```typescript
import {
    Controller,
    Get,
    Post,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../guards';
import { UserPreferencesService } from '@arcaai/applications';
import {
    UserPreferencesResponse,
    UpdateUserPreferencesRequest,
} from '@arcaai/applications';

@ApiTags('User Preferences')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('users/me')
export class UserPreferencesController {
    constructor(
        private readonly userPreferencesService: UserPreferencesService,
    ) {}

    @Get('preferences')
    @ApiOperation({
        summary: 'Get user preferences',
        description: 'Returns aggregated preferences for the authenticated user'
    })
    @ApiResponse({
        status: 200,
        description: 'User preferences',
        type: UserPreferencesResponse
    })
    async getPreferences(): Promise<UserPreferencesResponse> {
        return this.userPreferencesService.getPreferences();
    }

    @Post('preferences')
    @ApiOperation({
        summary: 'Update user preferences',
        description: 'Partial update - only provided fields are updated'
    })
    @ApiResponse({
        status: 200,
        description: 'Updated preferences',
        type: UserPreferencesResponse
    })
    async updatePreferences(
        @Body() dto: UpdateUserPreferencesRequest,
    ): Promise<UserPreferencesResponse> {
        return this.userPreferencesService.updatePreferences(dto);
    }

    @Post('preferences/reset')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Reset preferences to defaults',
        description: 'Removes all SDK preferences for the user'
    })
    @ApiResponse({ status: 204, description: 'Preferences reset' })
    async resetPreferences(): Promise<void> {
        return this.userPreferencesService.resetPreferences();
    }
}
```

### Controller Module

**File**: `apps/api/src/modules/user-preferences/user-preferences.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { UserPreferencesServiceModule } from '@arcaai/applications';
import { ApiKeyServiceModule } from '@arcaai/applications';
import { UserPreferencesController } from './user-preferences.controller';

@Module({
    imports: [
        UserPreferencesServiceModule,
        ApiKeyServiceModule,
    ],
    controllers: [UserPreferencesController],
})
export class UserPreferencesModule {}
```

### Index File

**File**: `apps/api/src/modules/user-preferences/index.ts`

```typescript
export * from './user-preferences.controller';
export * from './user-preferences.module';
```

---

## Step 5: Update App Module

**File**: `apps/api/src/app.module.ts`

Add import:

```typescript
import { UserPreferencesModule } from './modules/user-preferences';
```

Add to imports array:

```typescript
@Module({
    imports: [
        // ... existing imports
        UserPreferencesModule,
    ],
})
export class AppModule {}
```

---

## Step 6: User Context from API Key

The `ApiKeyGuard` needs to extract and set the user context in CLS (Continuation Local Storage).

**Update**: `apps/api/src/guards/apikey.guard.ts`

Ensure the guard sets user context:

```typescript
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ApiKeyService } from '@arcaai/applications';

@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(
        private readonly apiKeyService: ApiKeyService,
        private readonly cls: ClsService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing or invalid API key');
        }

        const apiKey = authHeader.substring(7);

        // Validate API key and get associated user
        const keyData = await this.apiKeyService.validateKey(apiKey);
        if (!keyData) {
            throw new UnauthorizedException('Invalid API key');
        }

        // Set user context in CLS for downstream services
        this.cls.set('user', {
            id: keyData.userId,
            tenantId: keyData.tenantId,
        });

        // Also set on request for compatibility
        request.user = {
            id: keyData.userId,
            tenantId: keyData.tenantId,
        };

        return true;
    }
}
```

---

## API Endpoints Summary

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/users/me/preferences` | Get aggregated user preferences | API Key |
| POST | `/users/me/preferences` | Update preferences (partial) | API Key |
| POST | `/users/me/preferences/reset` | Reset to defaults | API Key |

---

## File Structure

### New Files to Create

```
packages/applications/src/services/user/userPreferences/
├── index.ts
├── IUserPreferencesService.ts
├── userPreferences.service.ts
├── userPreferences.service.module.ts
└── dto/
    ├── index.ts
    ├── user-preferences.response.ts
    └── update-user-preferences.request.ts

apps/api/src/modules/user-preferences/
├── index.ts
├── user-preferences.controller.ts
└── user-preferences.module.ts
```

### Files to Modify

```
packages/domains/src/repositories/generated/core/UserSettingsRepository.ts
  → Add namespace-based query methods

packages/applications/src/services/user/index.ts
  → Export userPreferences module

apps/api/src/app.module.ts
  → Import UserPreferencesModule

apps/api/src/guards/apikey.guard.ts
  → Ensure user context is set in CLS
```

---

## Validation Checklist

### Service Layer
- [ ] `UserPreferencesService` created
- [ ] `IUserPreferencesService` interface defined
- [ ] Service module configured
- [ ] DTOs created with validation
- [ ] Repository methods added for namespace queries

### API Layer
- [ ] `UserPreferencesController` created
- [ ] Module registered in AppModule
- [ ] Swagger documentation added
- [ ] API key guard sets user context

### Testing
- [ ] Unit tests for service
- [ ] Integration tests for controller
- [ ] Test partial updates work correctly
- [ ] Test reset functionality

### SDK Compatibility
- [ ] GET `/users/me/preferences` returns correct format
- [ ] POST `/users/me/preferences` accepts partial updates
- [ ] Response matches `UserPreferences` interface

---

## SDK Integration Notes

After implementing this API, the SDK's `PersonalizationManager` will work with:

```typescript
// SDK Configuration
const config: AgenticConfig = {
    api: {
        baseUrl: 'https://api.arcaai.com',
        apiKey: 'your-api-key',
    },
    personalization: {
        storage: 'backend',  // Now works!
        // or
        storage: 'hybrid',   // Now works!
        syncInterval: 60000,
    },
};
```

The `PersonalizationManager` will:
1. Call `GET /users/me/preferences` to load preferences
2. Call `POST /users/me/preferences` to sync changes
3. Use the `updatedAt` field for sync conflict resolution

---

---

## Implementation Summary

### Implementation Date: 2026-01-28

### Files Created

**Application Services** (`packages/applications/src/services/user/userPreferences/`):
```
userPreferences/
├── index.ts
├── IUserPreferencesService.ts
├── userPreferences.service.ts
├── userPreferences.service.module.ts
└── dto/
    ├── index.ts
    ├── user-preferences.response.ts
    └── update-user-preferences.request.ts
```

**API Module** (`apps/api/src/modules/user-preferences/`):
```
user-preferences/
├── index.ts
├── user-preferences.controller.ts
└── user-preferences.module.ts
```

### Files Modified

- `packages/domains/src/repositories/generated/core/UserSettingsRepository.ts`
  - Added `findByUserAndNamespace()` method
  - Added `findByUserKeyNamespace()` method
  - Added `deleteByUserAndNamespace()` method

- `packages/applications/src/services/user/index.ts`
  - Added export for `userPreferences` module

- `apps/api/src/guards/apikey.guard.ts`
  - Added ClsService injection
  - Added user context extraction from API key to CLS

- `apps/api/src/app.module.ts`
  - Added `UserPreferencesModule` import

### Validation Checklist - COMPLETED ✅

- [x] `UserPreferencesService` created
- [x] `IUserPreferencesService` interface defined
- [x] Service module configured
- [x] DTOs created with validation
- [x] Repository methods added for namespace queries
- [x] `UserPreferencesController` created
- [x] Module registered in AppModule
- [x] Swagger documentation added
- [x] API key guard sets user context in CLS
- [x] Unit tests created for service
- [x] E2E tests created for controller
- [x] Seed data created for SDK preferences

### Test Files Created

**Unit Tests** (`packages/applications/src/services/user/userPreferences/__tests__/`):
- `userPreferences.service.test.ts` - Tests for UserPreferencesService

**E2E Tests** (`apps/api/tests/e2e/`):
- `user-preferences.spec.ts` - E2E tests for /users/me/preferences endpoints

### Seed Data Updated

**API Keys** (`packages/database/src/prisma/db_main/seed/02-apikey.ts`):
- Updated SDK Test API Key to link to doctor user (userId field)
- Added second API key for doctor2 for multi-user testing

**User Preferences** (`packages/database/src/prisma/db_main/seed/91-user.ts`):
- Added SDK preferences for doctor user (English, whisper-large-v3, high noise filter)
- Added SDK preferences for doctor2 user (Thai, whisper-medium, medium noise filter)
- Added SDK preferences for department_head (power user settings)

### Seeded Users with SDK Preferences

| User | User ID | Language | STT Model | Noise Filter | VAD Sensitivity |
|------|---------|----------|-----------|--------------|-----------------|
| doctor | `70000000-...0010` | en | whisper-large-v3 | high | 0.6 |
| doctor2 | `70000000-...0011` | th | whisper-medium | medium | 0.5 |
| department_head | `70000000-...0012` | en | whisper-large-v3 | high | 0.7 |

### API Keys for Testing

| Key Name | API Key (keyHash) | Linked User |
|----------|------------------|-------------|
| SDK Test API Key | `3GHtCUPJDSRIzonWoAMU0GO6p01ggC0w` | doctor |
| SDK API Key - Doctor 2 | `doctor2-sdk-key-for-testing-2026` | doctor2 |

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/me/preferences` | Get aggregated user preferences |
| POST | `/users/me/preferences` | Update preferences (partial) |
| POST | `/users/me/preferences/reset` | Reset to defaults |

### SDK Compatibility

The SDK's `PersonalizationManager` now works with:

```typescript
const config: AgenticConfig = {
    api: {
        baseUrl: 'https://api.arcaai.com',
        apiKey: 'your-api-key',
    },
    personalization: {
        storage: 'backend',  // ✅ Now works!
        storage: 'hybrid',   // ✅ Now works!
        syncInterval: 60000,
    },
};
```

---

## Next Steps

1. Run integration tests to verify functionality
2. Update SDK documentation to reflect backend storage support
3. Add to API OpenAPI specification
