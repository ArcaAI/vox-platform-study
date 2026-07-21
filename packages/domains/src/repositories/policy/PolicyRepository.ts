/**
 * `PolicyRepository` is the thin facade that
 * encapsulates `databaseService.client.policy.*` for `PolicyService`.
 *
 * It deliberately does **not** extend the generic
 * `Repository<DomainEntity extends BaseEntity, DataModel>` base class
 * because (a) the per-ticket constraint blocks the creation of a
 * matching `PolicyEntity` aggregate under `packages/domains/src/entities/`
 * and (b) the consuming service speaks in the structural `PolicyRecord`
 * (declared in `IPolicyService`), not in a domain aggregate.
 *
 * The repository preserves the legacy Prisma call shapes verbatim:
 *
 *   • `findMany(args)` / `count(args)` — pass-through; caller owns
 *     `where`, `skip`, `take`, `orderBy`, `include`. This preserves
 *     compatibility with the soft-delete-aware extended client (which
 *     filters DELETED on `findMany`/`count`).
 *   • `findById(id)` uses `findUnique`, not `findFirst`, so a
 *     soft-deleted row is still visible to the existence check on the
 *     `softDelete` re-entry path (verbatim legacy behaviour).
 *   • `softDelete` is the only place where the audit-stamp pattern is
 *     centralised (all existing deletes were confirmed soft already).
 */
import { Inject, Injectable } from '@nestjs/common';
import { CoreDatabaseService } from '../../common/databaseServices/core/core.database.service';
import { ResourceStatusType } from '../../enums';
import type { PolicyCreateInputShape, PolicyUpdateInputShape } from './PolicyFactory';

/** Structural shape of the Prisma `policy` delegate this repository
 *  needs. Declared as a local interface so unit tests can substitute a
 *  plain `vi.fn()`-backed object without conjuring the Prisma generic. */
interface PolicyDelegateLike {
  findMany: (args: unknown) => Promise<unknown[]>;
  count: (args: unknown) => Promise<number>;
  findUnique: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
}

@Injectable()
export class PolicyRepository {
  constructor(@Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService) {}

  private get delegate(): PolicyDelegateLike {
    return (this.databaseService.client as unknown as { policy: PolicyDelegateLike }).policy;
  }

  async findMany(args: unknown): Promise<unknown[]> {
    return this.delegate.findMany(args);
  }

  async count(args: unknown): Promise<number> {
    return this.delegate.count(args);
  }

  async findById(id: string): Promise<unknown> {
    return this.delegate.findUnique({ where: { id } });
  }

  async create(data: PolicyCreateInputShape): Promise<unknown> {
    return this.delegate.create({ data });
  }

  async update(id: string, data: PolicyUpdateInputShape): Promise<unknown> {
    return this.delegate.update({ where: { id }, data });
  }

  async softDelete(id: string, updatedBy?: string): Promise<unknown> {
    return this.delegate.update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: updatedBy,
      },
    });
  }
}
