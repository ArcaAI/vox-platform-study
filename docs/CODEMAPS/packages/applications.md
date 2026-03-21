# Applications Package Codemap

**Last Updated:** 2026-03-14  
**Package:** `@arcaai/applications`  
**Language:** TypeScript + NestJS  
**Pattern:** Clean Architecture / Hexagonal Architecture  
**Entry Point:** [src/index.ts](../../../../packages/applications/src/index.ts)

---

## 📋 Purpose

Application/service layer implementing use cases, business logic orchestration, and dependency injection. Bridges domain entities with NestJS controllers. Contains all application-specific services, DTOs, and module definitions.

---

## 🗂️ Directory Structure

```
packages/applications/src/
├── index.ts                   # Public exports
│
├── modules/                   # NestJS modules (one per domain)
│   ├── auth/                  # Authentication use cases
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts    # Use case orchestration
│   │   ├── auth.repository.ts # IUserRepository impl
│   │   ├── strategies/        # Passport strategies
│   │   │   ├── jwt.strategy.ts
│   │   │   ├── local.strategy.ts
│   │   │   └── api-key.strategy.ts
│   │   └── dtos/
│   │       ├── login.dto.ts
│   │       └── register.dto.ts
│   │
│   ├── user/                  # User management use cases
│   │   ├── user.module.ts
│   │   ├── user.service.ts
│   │   ├── user.repository.ts
│   │   ├── dtos/
│   │   │   ├── create-user.dto.ts
│   │   │   ├── update-user.dto.ts
│   │   │   └── user-response.dto.ts
│   │   └── __tests__/
│   │
│   ├── consultation/          # Consultation use cases
│   │   ├── consultation.module.ts
│   │   ├── consultation.service.ts
│   │   ├── consultation.repository.ts
│   │   ├── message.service.ts
│   │   └── dtos/
│   │       ├── create-consultation.dto.ts
│   │       ├── add-message.dto.ts
│   │       └── consultation-response.dto.ts
│   │
│   ├── storage/               # File storage use cases
│   │   ├── storage.module.ts
│   │   ├── storage.service.ts
│   │   └── dtos/
│   │
│   ├── audit/                 # Audit logging use cases
│   │   ├── audit.module.ts
│   │   ├── audit.service.ts
│   │   └── dtos/
│   │
│   └── index.ts               # Module exports
│
├── repositories/              # Repository implementations
│   ├── user.repository.ts     # IUserRepository impl
│   ├── consultation.repository.ts
│   ├── patient-profile.repository.ts
│   ├── base.repository.ts     # Abstract base repo
│   └── index.ts
│
├── dtos/                      # Shared Data Transfer Objects
│   ├── pagination.dto.ts      # Pagination metadata
│   ├── error.dto.ts           # Error responses
│   ├── timestamp.dto.ts       # Timestamp fields
│   └── index.ts
│
├── mappers/                   # Domain ↔ DTO mappers
│   ├── user.mapper.ts
│   ├── consultation.mapper.ts
│   └── index.ts
│
├── use-cases/                 # Explicit use case implementations
│   ├── auth/
│   │   ├── login.use-case.ts
│   │   ├── register.use-case.ts
│   │   ├── refresh-token.use-case.ts
│   │   └── logout.use-case.ts
│   │
│   ├── consultation/
│   │   ├── create-consultation.use-case.ts
│   │   ├── add-message.use-case.ts
│   │   └── close-consultation.use-case.ts
│   │
│   └── index.ts
│
├── interfaces/                # Application interfaces
│   ├── repository.interface.ts # IRepository<T>
│   ├── use-case.interface.ts   # IUseCase<Input, Output>
│   └── index.ts
│
├── middleware/                # NestJS middleware
│   ├── audit.middleware.ts    # Log all operations
│   ├── tenant.middleware.ts   # Inject tenant context
│   └── index.ts
│
├── services/                  # Cross-cutting application services
│   ├── event.service.ts       # Domain event publishing
│   ├── cache.service.ts       # Redis caching
│   ├── microservice.service.ts # Call Python services
│   └── index.ts
│
├── guards/                    # Permission/auth guards
│   ├── role.guard.ts          # Role-based access
│   ├── permission.guard.ts    # Feature permission
│   └── index.ts
│
├── decorators/                # NestJS decorators
│   ├── public.decorator.ts    # @Public() skip auth
│   ├── audit.decorator.ts     # @Audit() track changes
│   └── index.ts
│
├── exceptions/                # Application-level exceptions
│   ├── user-not-found.exception.ts
│   ├── invalid-credentials.exception.ts
│   ├── unauthorized.exception.ts
│   └── index.ts
│
├── common/                    # Shared utilities
│   ├── constants.ts           # App constants
│   ├── helpers.ts             # Helper functions
│   └── index.ts
│
└── __tests__/                 # Integration tests
    ├── services/
    ├── repositories/
    └── use-cases/
```

---

## 🔄 Use Case Pattern

Each use case encapsulates a single user story or business process.

```typescript
// Use Case: Login
export class LoginUseCase implements IUseCase<LoginInput, LoginOutput> {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(input: LoginInput): Promise<LoginOutput> {
    // 1. Validate input
    // 2. Find user by email
    // 3. Verify password
    // 4. Generate JWT token
    // 5. Return token + user info
    // 6. Emit event (UserLoggedIn)
  }
}
```

---

## 🏛️ Repository Implementation Pattern

```typescript
// Repository: IUserRepository implementation
@Injectable()
export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: UUID): Promise<User | null> {
    const data = await this.prisma.user.findUnique({
      where: { id: id.toString() },
    });
    
    if (!data) return null;
    
    // Map Prisma record → Domain entity
    return UserMapper.toDomain(data);
  }

  async save(user: User): Promise<void> {
    const data = UserMapper.toPersistence(user);
    await this.prisma.user.upsert({
      where: { id: user.getId().toString() },
      update: data,
      create: data,
    });
  }
}
```

---

## 🎯 DTO Pattern

Request/response DTOs shield domain from controller concerns.

```typescript
// Input DTO
export class CreateUserDTO {
  @IsEmail()
  email!: string;

  @MinLength(8)
  password!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}

// Output DTO
export class UserResponseDTO {
  id!: string;
  email!: string;
  role!: UserRole;
  createdAt!: Date;
  updatedAt!: Date;
}
```

---

## 🚀 Service Orchestration

NestJS services coordinate repositories, external calls, and events.

```typescript
// Application Service
@Injectable()
export class ConsultationService {
  constructor(
    private readonly consultationRepo: IConsultationRepository,
    private readonly messageRepo: IMessageRepository,
    private readonly eventService: EventService,
    private readonly sttService: MicroserviceService,
  ) {}

  async createConsultation(
    input: CreateConsultationDTO
  ): Promise<ConsultationResponseDTO> {
    // 1. Validate input
    // 2. Check permissions
    // 3. Create entity
    // 4. Persist
    // 5. Publish event
    // 6. Return DTO
  }

  async addMessage(
    consultationId: string,
    input: AddMessageDTO
  ): Promise<MessageResponseDTO> {
    // 1. Load consultation aggregate
    // 2. Add message via domain method
    // 3. Persist changes
    // 4. If audio → call STT service
    // 5. Return message DTO
  }
}
```

---

## 🧩 Module Structure (NestJS)

```typescript
// Auth Module - exposes AuthService (use case orchestration)
@Module({
  providers: [
    LoginUseCase,
    RegisterUseCase,
    AuthService,
    {
      provide: IUserRepository,
      useClass: UserRepository,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}

// Root App Module
@Module({
  imports: [
    AuthModule,
    UserModule,
    ConsultationModule,
    StorageModule,
    AuditModule,
  ],
})
export class AppModule {}
```

---

## 🔗 External Dependencies

### NestJS Ecosystem
- `@nestjs/common` — Decorators, pipes, guards, interceptors
- `@nestjs/jwt` — JWT token handling
- `@nestjs/passport` — Passport strategies
- `@nestjs/event-emitter` — Domain event publishing
- `@nestjs/config` — Configuration management

### Data Validation
- `class-validator` — DTO validation
- `class-transformer` — DTO serialization

### Database
- Uses `@arcaai/database` (Prisma client)

### Domain
- Uses `@arcaai/domains` (entities, repositories)

---

## 🔐 Cross-Cutting Concerns

### Audit Logging
```typescript
@Audit({ action: 'CREATE', entity: 'User' })
async createUser(input: CreateUserDTO): Promise<UserResponseDTO> {
  // Automatically logs who created what, when
}
```

### Tenant Context Injection
```typescript
// From request context
const tenantId = req.user.tenantId;
// Used in all repository queries for isolation
```

### Event Publishing
```typescript
// Emit domain event
this.eventService.publish(new UserCreatedEvent(user));

// Other services can listen
@EventListener()
onUserCreated(event: UserCreatedEvent) {
  // Send welcome email, etc.
}
```

---

## 🧪 Testing Pattern

```typescript
describe('LoginUseCase', () => {
  let useCase: LoginUseCase;
  let userRepository: jest.Mocked<IUserRepository>;

  beforeEach(() => {
    userRepository = createMockRepository();
    useCase = new LoginUseCase(userRepository, jwtService);
  });

  it('should login user with valid credentials', async () => {
    // Arrange
    const input = { email: 'user@test.com', password: 'password123' };
    userRepository.findByEmail.mockResolvedValue(mockUser);

    // Act
    const output = await useCase.execute(input);

    // Assert
    expect(output.token).toBeDefined();
  });
});
```

---

## 📊 Data Flow

```
Controller (routes/auth/login)
  │
  ├─► Input Validation (DTO)
  │
  ├─► Services Layer
  │   ├─► AuthService (orchestration)
  │   │   └─► LoginUseCase
  │   │       ├─► IUserRepository.findByEmail()
  │   │       ├─► Password verification
  │   │       ├─► JWT generation
  │   │       └─► EventService.publish(UserLoggedIn)
  │
  ├─► Output DTO Transformation
  │
  └─► Response (JWT + user info)
```

---

## 🔗 Related Codemaps

- [Domains Package](./domains.md) — Domain entities + repositories
- [Database Package](./database.md) — Persistence via Prisma
- [API Gateway](../services/api-gateway.md) — NestJS controllers using this layer
- [Exceptions Package](./exceptions.md) — Application exceptions

---

**Status**: ✅ Current | Core use cases implemented
