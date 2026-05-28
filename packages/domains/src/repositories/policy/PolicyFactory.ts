/**
 * TASK-311 AC-2 — `PolicyFactory` centralises the build of the Prisma
 * `data` payload that `PolicyService` used to inline. The factory has
 * one responsibility: turn an application-shaped request into the
 * Prisma input. It owns no I/O and no NestJS DI surface so it is
 * trivially unit-testable.
 *
 * The shape is structurally compatible with `Prisma.PolicyCreateInput` /
 * `Prisma.PolicyUpdateInput` but is declared here as a plain TypeScript
 * type to keep the domain layer decoupled from the Prisma compile-time
 * surface (the domain layer already re-exports `Prisma` from
 * `@arcaai/database` for consumers who need it).
 */
import { ResourceStatusType } from '../../enums';

/** Allowed `Policy.scope` values; mirrors the enum in `db_main/enums.prisma`. */
export type PolicyScope = 'GLOBAL' | 'TENANT';

/** Properties required to seed a new `Policy` row. */
export interface PolicyCreateProps {
  name: string;
  description?: string;
  scope: PolicyScope;
  rules: unknown;
  createdBy?: string;
}

/** Properties that may participate in a `Policy` update. */
export interface PolicyUpdateProps {
  name?: string;
  description?: string;
  scope?: PolicyScope;
  rules?: unknown;
  /** Currently `'ENABLED'` / `'DISABLED'`. Setting this also stamps
   *  `resourceStatusUpdatedAt` + `resourceStatusUpdatedBy`. */
  resourceStatus?: string;
}

/** Shape of the persistence input the repository feeds to `client.policy.create`. */
export interface PolicyCreateInputShape {
  name: string;
  description?: string;
  scope: PolicyScope;
  rules: unknown;
  resourceStatus: ResourceStatusType;
  createdBy?: string;
}

/** Shape of the persistence input the repository feeds to `client.policy.update`. */
export interface PolicyUpdateInputShape {
  name?: string;
  description?: string;
  scope?: PolicyScope;
  rules?: unknown;
  resourceStatus?: ResourceStatusType | string;
  resourceStatusUpdatedAt?: Date;
  resourceStatusUpdatedBy?: string;
  updatedBy?: string;
}

export const PolicyFactory = {
  buildCreateInput(props: PolicyCreateProps): PolicyCreateInputShape {
    return {
      name: props.name,
      description: props.description,
      scope: props.scope,
      rules: props.rules,
      resourceStatus: ResourceStatusType.ENABLED,
      createdBy: props.createdBy,
    };
  },

  buildUpdateInput(props: PolicyUpdateProps, updatedBy?: string): PolicyUpdateInputShape {
    return {
      ...(props.name && { name: props.name }),
      ...(props.description !== undefined && { description: props.description }),
      ...(props.scope && { scope: props.scope }),
      ...(props.rules !== undefined && { rules: props.rules }),
      ...(props.resourceStatus && {
        resourceStatus: props.resourceStatus as ResourceStatusType,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: updatedBy,
      }),
      updatedBy,
    };
  },
} as const;
