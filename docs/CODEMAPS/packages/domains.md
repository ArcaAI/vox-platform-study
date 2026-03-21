# Domains Package Codemap

**Last Updated:** 2026-03-14  
**Package:** `@arcaai/domains`  
**Language:** TypeScript  
**Pattern:** Domain-Driven Design (DDD)  
**Entry Point:** [src/index.ts](../../../../packages/domains/src/index.ts)

---

## 📋 Purpose

Domain layer implementing Domain-Driven Design (DDD) patterns. Defines domain entities, value objects, repositories, and business rules independent of UI or database concerns. Acts as the core business logic abstraction.

---

## 🗂️ Directory Structure

```
packages/domains/src/
├── index.ts                   # Public exports
│
├── entities/                  # Domain entities (with business logic)
│   ├── user.entity.ts         # User aggregate root
│   ├── tenant.entity.ts       # Tenant aggregate root
│   ├── consultation.entity.ts # ConsultationSession aggregate
│   ├── message.entity.ts      # Message entity
│   └── patient-profile.entity.ts # PatientProfile
│
├── value-objects/             # Immutable value objects
│   ├── email.vo.ts            # Email validation
│   ├── uuid.vo.ts             # UUID wrapper
│   ├── specialty.vo.ts        # Medical specialty enum
│   └── medical-history.vo.ts  # Medical data wrapper
│
├── repositories/              # Repository interfaces (not implementations)
│   ├── user.repository.ts     # IUserRepository interface
│   ├── consultation.repository.ts # IConsultationRepository
│   ├── patient-profile.repository.ts
│   └── index.ts               # Export all repositories
│
├── factories/                 # Entity factories
│   ├── user.factory.ts        # Create User entities
│   ├── consultation.factory.ts
│   └── index.ts
│
├── mappers/                   # DTO ↔ Entity mappers
│   ├── user.mapper.ts         # Map User DTO ↔ Entity
│   ├── consultation.mapper.ts
│   └── index.ts
│
├── models/                    # Domain models (aggregate structures)
│   ├── user.model.ts          # User domain model
│   ├── consultation.model.ts
│   └── index.ts
│
├── enums/                     # Domain enums
│   ├── user-role.enum.ts      # admin | doctor | patient
│   ├── consultation-status.enum.ts
│   ├── medical-specialty.enum.ts
│   └── index.ts
│
├── interfaces/                # Domain interfaces
│   ├── entity.interface.ts    # IEntity base interface
│   ├── aggregate-root.interface.ts
│   └── index.ts
│
├── middlewares/               # Domain middleware/interceptors
│   ├── audit.middleware.ts
│   └── index.ts
│
├── common/                    # Cross-cutting domain concerns
│   ├── result.ts              # Result<T, E> type
│   ├── exception.ts           # Domain exceptions
│   └── index.ts
│
├── utils/                     # Domain utilities
│   ├── validators.ts          # Business rule validators
│   └── index.ts
│
└── __tests__/                 # Domain unit tests
    ├── entities/
    ├── value-objects/
    └── repositories/
```

---

## 🎯 Core Concepts

### Aggregate Root
Each entity that serves as the entry point to a cluster of related entities.

```typescript
// User Aggregate Root
export class User {
  private id: UUID;
  private email: Email;
  private role: UserRole;
  private passwordHash: string;
  private createdAt: Date;

  // Business methods (encapsulate logic)
  changePassword(newPassword: string): void { ... }
  updateProfile(data: UpdateProfileDTO): void { ... }
  isAdmin(): boolean { return this.role === UserRole.ADMIN; }
}
```

### Value Objects
Immutable objects that have no identity, only value equality.

```typescript
// Email Value Object
export class Email {
  private readonly address: string;

  constructor(address: string) {
    if (!this.isValidEmail(address)) {
      throw new InvalidEmailError();
    }
    this.address = address;
  }

  equals(other: Email): boolean {
    return this.address === other.address;
  }
}
```

### Repositories
Interface definitions (implementations live in `@arcaai/applications`).

```typescript
// Repository Interface (Domain)
export interface IUserRepository {
  findById(id: UUID): Promise<User | null>;
  save(user: User): Promise<void>;
  delete(id: UUID): Promise<void>;
}
```

### Factories
Create domain objects with complex initialization logic.

```typescript
export class UserFactory {
  static create(data: CreateUserDTO): User {
    const email = new Email(data.email);
    return new User(
      UUID.generate(),
      email,
      UserRole.parse(data.role),
      hashPassword(data.password),
      new Date()
    );
  }
}
```

### Mappers
Transform between domain objects and application DTOs.

```typescript
export class UserMapper {
  static toDTO(user: User): UserDTO {
    return {
      id: user.getId().toString(),
      email: user.getEmail().toString(),
      role: user.getRole(),
    };
  }

  static toDomain(dto: UserDTO): User {
    return new User(
      UUID.from(dto.id),
      new Email(dto.email),
      UserRole.parse(dto.role)
    );
  }
}
```

---

## 🏗️ Entity Relationships

```
┌──────────────────────────────────────────────────────┐
│                      Tenant                          │
│          (Aggregator for multi-tenancy)              │
└────────┬─────────────────────────────────────────────┘
         │
         ├─────► User (owns)
         │       ├─ User (many users per tenant)
         │       └─ UserRole
         │
         ├─────► ConsultationSession (owns)
         │       ├─ doctor_id (FK to User)
         │       ├─ patient_id (FK to User)
         │       ├─ specialty
         │       └─ Messages[] (many messages)
         │
         └─────► PatientProfile (owns)
                 └─ Patient medical data
```

---

## 🔌 Key Entities

| Entity | Purpose | Key Methods |
|--------|---------|-------------|
| **User** | User profiles + auth | `changePassword()`, `updateProfile()`, `isAdmin()` |
| **Tenant** | Account isolation | `getName()`, `getUsers()` |
| **ConsultationSession** | Consultation state | `addMessage()`, `close()`, `getMessages()` |
| **Message** | Chat messages | `getContent()`, `getSender()` |
| **PatientProfile** | Medical data | `updateMedicalHistory()`, `getMedications()` |

---

## 🧪 Example Domain Logic

```typescript
// Domain entity with business logic
export class ConsultationSession {
  private id: UUID;
  private doctorId: UUID;
  private patientId: UUID;
  private specialty: MedicalSpecialty;
  private messages: Message[] = [];
  private status: ConsultationStatus = ConsultationStatus.ACTIVE;
  private createdAt: Date;

  // Business method: Add message with validation
  addMessage(sender: User, content: string): void {
    if (this.status !== ConsultationStatus.ACTIVE) {
      throw new ConsultationClosedError();
    }
    if (!content || content.trim().length === 0) {
      throw new InvalidMessageError();
    }
    if (sender.getId() !== this.doctorId && sender.getId() !== this.patientId) {
      throw new UnauthorizedError();
    }

    const message = new Message(
      UUID.generate(),
      sender,
      content,
      new Date()
    );
    this.messages.push(message);
  }

  // Query method
  getMessages(): ReadonlyArray<Message> {
    return Object.freeze([...this.messages]);
  }

  // Status transition
  close(): void {
    if (this.status === ConsultationStatus.CLOSED) {
      throw new AlreadyClosedError();
    }
    this.status = ConsultationStatus.CLOSED;
  }
}
```

---

## 🔗 Dependencies

### External
- `class-validator` — Input validation
- `class-transformer` — Object transformation

### Usage Pattern
- Used by `@arcaai/applications` (service layer)
- Repository implementations in `@arcaai/applications`
- Mappers import from this package

---

## 🧩 Export Structure

```typescript
// Single source of truth exports
export * from './entities';
export * from './value-objects';
export * from './repositories';
export * from './factories';
export * from './enums';
export * from './interfaces';
export * from './mappers';
export type * from './models';
```

---

## 🎓 DDD Principles Applied

- **Bounded Context** — Each service has distinct domains
- **Aggregates** — Entity + related entities form aggregate
- **Value Objects** — Immutable, no identity
- **Repository Pattern** — Abstract data access
- **Factory Pattern** — Complex object creation
- **Mapper Pattern** — DTO ↔ Entity translation
- **Exception Hierarchy** — Domain-specific errors

---

## 🔗 Related Codemaps

- [Applications Package](./applications.md) — Implements repositories, services
- [Database Package](./database.md) — Persistence layer
- [Exceptions Package](./exceptions.md) — Domain exceptions

---

**Status**: ✅ Current | Core domain entities established
