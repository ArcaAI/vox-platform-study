# API Gateway Development Guide

**Version**: 1.0
**Last Updated**: 2025-01-10
**Audience**: Backend Developers, DevOps Engineers

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Setup](#environment-setup)
- [Development Workflow](#development-workflow)
- [Code Structure](#code-structure)
- [Creating New Features](#creating-new-features)
- [Working with Database](#working-with-database)
- [Authentication & Authorization](#authentication--authorization)
- [Testing](#testing)
- [Debugging](#debugging)
- [Best Practices](#best-practices)
- [Common Tasks](#common-tasks)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software

| Software | Version | Installation |
|----------|---------|--------------|
| **Node.js** | 18+ (recommended 20.x) | https://nodejs.org/ |
| **pnpm** | 10.6.5+ | `npm install -g pnpm` |
| **PostgreSQL** | 14+ | https://www.postgresql.org/ |
| **Redis** | 7+ | https://redis.io/ |
| **Docker** | Latest | https://www.docker.com/ |
| **Git** | Latest | https://git-scm.com/ |

### Optional Tools

- **Postman** or **Insomnia**: API testing
- **pgAdmin** or **DBeaver**: Database management
- **RedisInsight**: Redis visualization
- **VS Code**: Recommended IDE with extensions:
  - ESLint
  - Prettier
  - Prisma
  - Thunder Client (API testing)
  - Docker

### Skills & Knowledge

- TypeScript and modern JavaScript (ES6+)
- NestJS framework fundamentals
- RESTful API design principles
- SQL and database concepts
- Docker and containerization basics
- Git version control

---

## Environment Setup

### 1. Clone the Repository

```bash
# Clone the monorepo
git clone <repository-url>
cd HOPE

# Checkout to development branch
git checkout develop
```

### 2. Install Dependencies

```bash
# Install all workspace dependencies
pnpm install

# This will install dependencies for:
# - Root workspace
# - apps/api
# - All packages in packages/
```

### 3. Set Up Environment Variables

```bash
# Navigate to API directory
cd apps/api

# Copy environment template
cp env.example .env

# Edit .env with your local configuration
nano .env
```

**Minimal .env configuration for local development:**

```bash
NODE_ENV=development
PORT=8868

# Database
DB_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/hope_dev
DB_CONNECTION_STRING_DIRECT=postgresql://postgres:postgres@localhost:5432/hope_dev

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=

# Python Services (local)
STT_V2_URL=http://localhost:8861
SMR_URL=http://localhost:8862
TTS_URL=http://localhost:8863
NLP_URL=http://localhost:8864
FEDL_URL=http://localhost:8865

# Session
SESSION_SECRET_KEY=dev-secret-key-change-in-production

# Logging
LOG_LEVEL=debug
LOG_FILE_ENABLED=true
LOG_FILE_PATH=./logs
```

### 4. Set Up Infrastructure Services

#### Option A: Using Docker Compose (Recommended)

```bash
# Navigate to infrastructure directory
cd ../../infrastructure/docker

# Start all services (PostgreSQL, Redis, Kafka, etc.)
make dev-up

# Verify services are running
docker-compose -f docker-compose.dev.yml ps
```

#### Option B: Manual Setup

**PostgreSQL:**
```bash
# Install PostgreSQL
# macOS
brew install postgresql@17
brew services start postgresql@17

# Create database
createdb hope_dev
```

**Redis:**
```bash
# Install Redis
# macOS
brew install redis
brew services start redis
```

### 5. Set Up Database

```bash
# Navigate to database package
cd ../../packages/database

# Run migrations
npx prisma migrate dev

# Generate Prisma Client
npx prisma generate

# (Optional) Seed database
pnpm seed
```

### 6. Start the API Gateway

```bash
# Navigate back to API directory
cd ../../apps/api

# Start development server
pnpm dev

# The API will be available at http://localhost:8868
# Swagger UI: http://localhost:8868/api/v1/docs
```

---

## Development Workflow

### Daily Development Flow

```bash
# 1. Pull latest changes
git pull origin develop

# 2. Install any new dependencies
pnpm install

# 3. Run database migrations (if any)
cd packages/database && npx prisma migrate dev

# 4. Start development server
cd ../../apps/api && pnpm dev

# 5. Make your changes
# 6. Test your changes
# 7. Commit and push
```

### Git Workflow

```bash
# Create feature branch
git checkout -b feature/your-feature-name

# Make changes and commit
git add .
git commit -m "feat: add new feature description"

# Push to remote
git push origin feature/your-feature-name

# Create Pull Request on GitHub/GitLab
```

### Commit Message Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix bug in session controller
docs: update API documentation
style: format code
refactor: refactor authentication logic
test: add tests for session service
chore: update dependencies
```

---

## Code Structure

### Module Organization

Each feature should be organized as a NestJS module:

```
src/controllers/feature-name/
├── feature-name.module.ts      # Module definition
├── feature-name.controller.ts  # HTTP endpoints
├── feature-name.service.ts     # Business logic (if needed)
├── feature-name.gateway.ts     # WebSocket gateway (if needed)
├── dto/                        # Data Transfer Objects
│   ├── create-feature.dto.ts
│   ├── update-feature.dto.ts
│   └── feature-response.dto.ts
└── index.ts                    # Barrel exports
```

### Shared Components

```
src/
├── guards/           # Authentication/Authorization guards
├── decorators/       # Custom decorators
├── interceptors/     # Request/response interceptors
├── filters/          # Exception filters
├── middlewares/      # Middleware functions
└── services/         # Shared services
```

---

## Creating New Features

### Step-by-Step Guide

#### 1. Create Module Structure

```bash
# Navigate to controllers directory
cd src/controllers

# Create feature directory
mkdir example
cd example
```

#### 2. Create the Module

```typescript
// example.module.ts
import { Module } from '@nestjs/common';
import { ExampleController } from './example.controller';

@Module({
  imports: [],
  controllers: [ExampleController],
  providers: [],
  exports: [],
})
export class ExampleModule {}
```

#### 3. Create DTOs

```typescript
// dto/create-example.dto.ts
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateExampleDto {
  @ApiProperty({
    description: 'Example name',
    example: 'Test Example',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Optional description',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;
}

// dto/example-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class ExampleResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false })
  description?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
```

#### 4. Create Controller

```typescript
// example.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../../guards';
import { CreateExampleDto, ExampleResponseDto } from './dto';

@ApiTags('examples')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('examples')
export class ExampleController {
  constructor() {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new example' })
  @ApiResponse({
    status: 201,
    description: 'Example created successfully',
    type: ExampleResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input data',
  })
  async create(
    @Body() createDto: CreateExampleDto,
  ): Promise<ExampleResponseDto> {
    // Implementation here
    return {
      id: 'example-id',
      name: createDto.name,
      description: createDto.description,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get all examples' })
  @ApiResponse({
    status: 200,
    description: 'List of examples',
    type: [ExampleResponseDto],
  })
  async findAll(): Promise<ExampleResponseDto[]> {
    // Implementation here
    return [];
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get example by ID' })
  @ApiResponse({
    status: 200,
    description: 'Example found',
    type: ExampleResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Example not found',
  })
  async findOne(@Param('id') id: string): Promise<ExampleResponseDto> {
    // Implementation here
    return {
      id,
      name: 'Example',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update example' })
  async update(
    @Param('id') id: string,
    @Body() updateDto: CreateExampleDto,
  ): Promise<ExampleResponseDto> {
    // Implementation here
    return {
      id,
      name: updateDto.name,
      description: updateDto.description,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete example' })
  async remove(@Param('id') id: string): Promise<void> {
    // Implementation here
  }
}
```

#### 5. Register Module

```typescript
// src/app.module.ts
import { ExampleModule } from './controllers/example/example.module';

@Module({
  imports: [
    // ... other modules
    ExampleModule, // Add your new module
  ],
})
export class AppModule {}
```

#### 6. Test the Endpoints

```bash
# Start the server
pnpm dev

# Access Swagger UI
open http://localhost:8868/api/v1/docs

# Test your endpoints using Swagger or curl
curl -X POST http://localhost:8868/api/v1/examples \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"name": "Test Example"}'
```

---

## Working with Database

### Using Prisma Client

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@repo/database';

@Injectable()
export class ExampleService {
  private prisma = new PrismaClient();

  async create(data: { name: string; description?: string }) {
    return this.prisma.example.create({
      data: {
        ...data,
        tenantId: 'current-tenant-id', // Get from context
      },
    });
  }

  async findAll(tenantId: string) {
    return this.prisma.example.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.example.findUnique({
      where: { id },
    });
  }

  async update(id: string, data: { name?: string; description?: string }) {
    return this.prisma.example.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.example.delete({
      where: { id },
    });
  }
}
```

### Creating Migrations

```bash
# Navigate to database package
cd packages/database

# Create a new migration
npx prisma migrate dev --name add_example_table

# Apply migrations in production
npx prisma migrate deploy

# Reset database (development only)
npx prisma migrate reset
```

### Prisma Studio

```bash
# Open Prisma Studio for database visualization
cd packages/database
npx prisma studio

# Access at http://localhost:5555
```

---

## Authentication & Authorization

### Using Guards

#### API Key Authentication

```typescript
import { UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../../guards';

@UseGuards(ApiKeyGuard)
@Controller('protected')
export class ProtectedController {
  // All endpoints require valid API key
}
```

#### JWT Authentication

```typescript
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../guards';

@UseGuards(JwtAuthGuard)
@Controller('user-protected')
export class UserProtectedController {
  // All endpoints require valid JWT token
}
```

#### Role-Based Authorization

```typescript
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard } from '../../guards';
import { UseRoles } from '../../decorators';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  @Post()
  @UseRoles('admin')
  async adminOnlyEndpoint() {
    // Only accessible by admin role
  }

  @Get()
  @UseRoles('admin', 'manager')
  async multipleRoles() {
    // Accessible by admin or manager
  }
}
```

#### Getting Authenticated User

```typescript
import { AuthUser } from '../../decorators';

@Controller('profile')
export class ProfileController {
  @Get()
  async getProfile(@AuthUser() user: any) {
    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
    };
  }
}
```

---

## Testing

### Unit Tests

```typescript
// example.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ExampleService } from './example.service';

describe('ExampleService', () => {
  let service: ExampleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExampleService],
    }).compile();

    service = module.get<ExampleService>(ExampleService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new example', async () => {
      const dto = { name: 'Test', description: 'Test description' };
      const result = await service.create(dto);

      expect(result).toBeDefined();
      expect(result.name).toBe('Test');
    });
  });
});
```

### E2E Tests

```typescript
// example.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('ExampleController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/api/examples (POST)', () => {
    return request(app.getHttpServer())
      .post('/api/examples')
      .set('X-API-Key', 'test-api-key')
      .send({ name: 'Test Example' })
      .expect(201)
      .expect((res) => {
        expect(res.body).toHaveProperty('id');
        expect(res.body.name).toBe('Test Example');
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
```

### Running Tests

```bash
# Run all unit tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run E2E tests
pnpm test:e2e

# Generate coverage report
pnpm test:cov
```

---

## Debugging

### VS Code Debug Configuration

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug API Gateway",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dev:debug"],
      "skipFiles": ["<node_internals>/**"],
      "cwd": "${workspaceFolder}/apps/api",
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen"
    }
  ]
}
```

### Logging

```typescript
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ExampleService {
  private readonly logger = new Logger(ExampleService.name);

  async someMethod() {
    this.logger.log('Processing started');
    this.logger.debug('Debug information', { data: 'value' });
    this.logger.warn('Warning message');
    this.logger.error('Error occurred', errorStack);
  }
}
```

### Using Node Inspector

```bash
# Start with debugging enabled
pnpm dev:debug

# Open chrome://inspect in Chrome browser
# Click "Open dedicated DevTools for Node"
```

---

## Best Practices

### Code Organization

1. **One responsibility per file**: Keep files focused and manageable
2. **Use barrel exports**: Create `index.ts` for clean imports
3. **Group by feature**: Organize code by business domain
4. **Shared code in packages**: Extract reusable code to shared packages

### Error Handling

```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

@Injectable()
export class ExampleService {
  async findOne(id: string) {
    const item = await this.prisma.example.findUnique({ where: { id } });

    if (!item) {
      throw new NotFoundException(`Example with ID ${id} not found`);
    }

    return item;
  }

  async create(data: any) {
    if (!data.name) {
      throw new BadRequestException('Name is required');
    }

    return this.prisma.example.create({ data });
  }
}
```

### Validation

Always use DTOs with validation decorators:

```typescript
import { IsString, IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  name: string;

  @IsEmail()
  email: string;
}
```

### Security

1. **Always use guards** for protected endpoints
2. **Validate all inputs** using class-validator
3. **Sanitize outputs** to prevent data leakage
4. **Never log sensitive data** (passwords, tokens, etc.)
5. **Use environment variables** for secrets

---

## Common Tasks

### Adding a New Environment Variable

1. Add to `env.example`:
```bash
NEW_VARIABLE=default_value
```

2. Add to your `.env`:
```bash
NEW_VARIABLE=actual_value
```

3. Access in code:
```typescript
const value = process.env.NEW_VARIABLE;
```

### Creating a Custom Decorator

```typescript
// custom.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CustomDecorator = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.customProperty;
  },
);

// Usage
@Get()
async getCustom(@CustomDecorator() customData: any) {
  return customData;
}
```

### Adding WebSocket Support

```typescript
// example.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ namespace: '/example' })
export class ExampleGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('message')
  handleMessage(client: Socket, payload: any) {
    // Handle message
    this.server.emit('response', { data: 'response' });
  }
}
```

---

## Troubleshooting

### Common Issues

#### Port Already in Use

```bash
# Find process using port 8868
lsof -i :8868

# Kill the process
kill -9 <PID>
```

#### Database Connection Issues

```bash
# Check PostgreSQL is running
pg_isready

# Check connection string in .env
# Ensure database exists
psql -U postgres -c "CREATE DATABASE hope_dev"
```

#### Redis Connection Issues

```bash
# Check Redis is running
redis-cli ping

# Should return: PONG
```

#### Module Not Found Errors

```bash
# Clear node_modules and reinstall
rm -rf node_modules pnpm-lock.yaml
pnpm install

# Generate Prisma Client
cd packages/database && npx prisma generate
```

#### TypeScript Compilation Errors

```bash
# Clean build artifacts
pnpm clean

# Rebuild
pnpm build
```

### Getting Help

1. Check the [Implementation Status](./01-implementation-status.md)
2. Review NestJS documentation: https://docs.nestjs.com/
3. Check existing code examples in the codebase
4. Ask the team on Slack/Discord
5. Create an issue in the project tracker

---

## Next Steps

After completing this guide:

1. Read the [Usage Guide](./03-usage-guide.md) for API usage examples
2. Review [Deployment Guide](./04-deployment-guide.md) for production deployment
3. Explore the codebase to understand existing patterns
4. Start implementing your first feature!

---

**Happy Coding! 🚀**

