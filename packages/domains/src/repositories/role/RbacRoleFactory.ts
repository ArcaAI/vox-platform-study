/**
 * `RbacRoleFactory` centralises the Prisma input shape
 * for `Role` mutations. Same simplification rationale as
 * `PolicyFactory`.
 *
 * Prefixed `Rbac` because there is a stale
 * `entities/factories/mappers/repositories/generated/core/Role*` chain
 * that cannot be renamed. The `Rbac` prefix follows the
 * `RbacRoleService` precedent.
 */
import { ResourceStatusType } from '../../enums';

/** Properties required to seed a new `Role` row. */
export interface RbacRoleCreateProps {
  name: string;
  description?: string;
  externalName?: string;
  externalId?: string;
  parentRoleId?: string;
  /** Defaults to `false`; only a global admin may pass `true`
   *  (enforced by `RbacRoleService.create`, not the factory). */
  isSystemRole?: boolean;
  createdBy?: string;
}

/** Properties that may participate in a `Role` update. `null` is
 *  treated as an explicit clear (preserves the verbatim legacy
 *  Prisma payload shape for `parentRoleId`/`description` clears). */
export interface RbacRoleUpdateProps {
  name?: string;
  description?: string | null;
  externalName?: string | null;
  externalId?: string | null;
  parentRoleId?: string | null;
  resourceStatus?: string;
}

export interface RbacRoleCreateInputShape {
  name: string;
  description?: string;
  externalName?: string;
  externalId?: string;
  parentRoleId?: string;
  isSystemRole: boolean;
  resourceStatus: ResourceStatusType;
  createdBy?: string;
}

export interface RbacRoleUpdateInputShape {
  name?: string;
  description?: string | null;
  externalName?: string | null;
  externalId?: string | null;
  parentRoleId?: string | null;
  resourceStatus?: ResourceStatusType | string;
  resourceStatusUpdatedAt?: Date;
  resourceStatusUpdatedBy?: string;
  updatedBy?: string;
}

export const RbacRoleFactory = {
  buildCreateInput(props: RbacRoleCreateProps): RbacRoleCreateInputShape {
    return {
      name: props.name,
      description: props.description,
      externalName: props.externalName,
      externalId: props.externalId,
      parentRoleId: props.parentRoleId,
      isSystemRole: props.isSystemRole ?? false,
      resourceStatus: ResourceStatusType.ENABLED,
      createdBy: props.createdBy,
    };
  },

  buildUpdateInput(props: RbacRoleUpdateProps, updatedBy?: string): RbacRoleUpdateInputShape {
    return {
      ...(props.name && { name: props.name }),
      ...(props.description !== undefined && { description: props.description }),
      ...(props.externalName !== undefined && { externalName: props.externalName }),
      ...(props.externalId !== undefined && { externalId: props.externalId }),
      ...(props.parentRoleId !== undefined && { parentRoleId: props.parentRoleId }),
      ...(props.resourceStatus && {
        resourceStatus: props.resourceStatus as ResourceStatusType,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: updatedBy,
      }),
      updatedBy,
    };
  },
} as const;
