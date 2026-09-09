// The feature-availability plane: what a caller's tenant may use, and the
// platform-admin matrix that decides it (TASK-932 R-4, R-8, R-10, R-14).
//
// -- TWO READS, DELIBERATELY DIFFERENT ---------------------------------------
//  - `resolveEffectiveForTenant` answers "which features exist for THIS tenant"
//    - one boolean per key plus the tier that supplied it. Every admin may ask
//    it about its own tenant; the console cannot decide whether to render a
//    screen without it (see the AUTH-NOTE on the route).
//  - `readMatrix` / `applyMatrix` are the platform admin's cross-tenant surface:
//    the SYSTEM default beside every tenant's override, `null` where a tenant
//    holds no opinion and therefore INHERITS. Super administrators only.
//
// -- WHY THE MATRIX READS UNSCOPED, AND HOW THAT IS SAFE ---------------------
// A cross-tenant matrix has to see every tenant's row, and the Prisma
// tenant-scope extension pins a read to the CLS tenant, so a platform admin
// with a working tenant selected would silently get a one-column matrix. The
// sanctioned way to widen is the extension's own rule: with NO CLS tenant and a
// super-admin principal it passes the query through unscoped
// (`applyTenantScopeExtension`, the `isSuperAdmin` branch). So the read runs
// inside a nested CLS context with the SAME user and no tenant - the shape
// `SettingsRegistryWriteService.actingOnTenant` already uses in the other
// direction. It is NOT the unscoped platform-admin Prisma client, which is
// lint-banned outside seeds, and it grants nothing: `assertPlatformMatrixAccess`
// has already refused a non-super-admin before any of this runs.
//
// -- VERSIONS COME FROM THE ROW, VALUES MAY COME FROM THE CACHE --------------
// Same split, and the same reason, as the write lane's constructor note: the
// OCC version must be FRESH or two admins inside one 45s cache window compare
// against the same stale number and the second silently clobbers the first. The
// effective VALUE is a policy read and tolerates the snapshot. So the matrix
// reads rows for `{ value, version }` and resolves effective values through
// `TenantSettingsService`, which is the same cascade the consumers enforce.

import { ForbiddenException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { GlobalSettingRepository, TenantRepository } from '@arcaai/domains';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { FEATURE_AVAILABILITY_CATEGORY } from './descriptors/feature-availability.descriptors';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import type { SettingDescriptor } from './registry.types';
import { type AdoptableRow, SettingsRegistryWriteService, pickBackingRow } from './settings-registry-write.service';
import { TenantSettingsService } from './tenant-settings.service';

/** The reserved platform-configuration tier. Never a customer tenant. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** The matrix column id for the platform-default row. */
export const PLATFORM_COLUMN = 'system';

export interface EffectiveFeature {
  key: string;
  value: boolean;
  /** Which tier answered: a tenant override, the platform row, or the code default. */
  sourceScope: 'system' | 'tenant' | 'default';
}

export interface FeatureMatrixCell {
  key: string;
  /** A tenant id, or `'system'` for the platform-default column. */
  tenantId: string;
  /** `null` = no row: this tenant INHERITS the platform default. */
  value: boolean | null;
  /** Backing row version; `0` when no row is stored (nothing to precondition). */
  version: number;
}

export interface FeatureMatrixTenant {
  id: string;
  name: string;
  slug: string;
}

export interface FeatureMatrix {
  features: SettingDescriptor[];
  tenants: FeatureMatrixTenant[];
  cells: FeatureMatrixCell[];
}

export interface FeatureMatrixWrite {
  key: string;
  tenantId: string;
  /** `null` = reset (a tenant cell drops its override; the platform cell returns to the descriptor default). */
  value: boolean | null;
  expectedVersion?: number;
}

export interface FeatureMatrixCellError {
  key: string;
  tenantId: string;
  /** The status this cell would have produced as a single-key request (412, 400, 403 ...). */
  status: number;
  message: string;
}

export interface FeatureMatrixWriteResult {
  cells: FeatureMatrixCell[];
  /** Per-cell failures. A batch is NOT all-or-nothing - see `applyMatrix`. */
  errors: FeatureMatrixCellError[];
}

@Injectable()
export class FeatureAvailabilityService {
  constructor(
    private readonly tenantSettings: TenantSettingsService,
    private readonly writeService: SettingsRegistryWriteService,
    private readonly globalSettingRepository: GlobalSettingRepository,
    private readonly tenantRepository: TenantRepository,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  /** Every `Feature Availability` descriptor, in registry order. */
  descriptors(): SettingDescriptor[] {
    return HOPE_SETTINGS_REGISTRY.list().filter((d) => d.category === FEATURE_AVAILABILITY_CATEGORY);
  }

  /**
   * The effective feature set for one tenant (or for the platform, when
   * `tenantId` is null - an elevated caller with no working tenant).
   *
   * `sourceScope` is reported so the console can SAY that a value is inherited
   * rather than chosen, which is the difference between a checkbox and a
   * checkbox someone can reason about.
   *
   * TASK-932 R-1 — a `maxScope: 'system'` key is OMITTED for a non-elevated
   * caller. Such a key is resolved on the PLATFORM lane whatever tenant asked
   * (the `null` below), so returning it would hand a tenant admin the platform
   * row's value — the same value `GET admin/settings/registry/:key` already
   * answers 404 for, which would make one route give away what the other
   * hides. Nothing is lost: a key the cascade will never honour per tenant
   * cannot gate anything on a tenant's console. Elevation is read from CLS
   * rather than passed in, so it comes from the same place as
   * `assertPlatformMatrixAccess` and no future caller can forget it.
   */
  resolveEffectiveForTenant(tenantId: string | null): EffectiveFeature[] {
    const elevated = isSuperAdmin(this.cls.get('user'));
    const visible = elevated ? this.descriptors() : this.descriptors().filter((d) => d.maxScope !== 'system');
    return visible.map((descriptor) => {
      const resolved = this.tenantSettings.resolve<boolean>(descriptor.key, descriptor.maxScope === 'system' ? null : tenantId);
      return {
        key: descriptor.key,
        value: resolved.value === true,
        sourceScope: resolved.source === 'code-default' ? 'default' : resolved.source,
      };
    });
  }

  /**
   * The cross-tenant matrix. Super administrators only - enforced by the
   * caller's `AUTH-NOTE` guard AND re-checked here, defence in depth.
   */
  async readMatrix(): Promise<FeatureMatrix> {
    this.assertPlatformMatrixAccess();
    const features = this.descriptors();
    const keys = features.map((d) => d.key);

    const { tenants, rows } = await this.readUnscoped(keys);

    const cells: FeatureMatrixCell[] = [];
    for (const descriptor of features) {
      cells.push(this.cellFor(descriptor, PLATFORM_COLUMN, rows));
      // A `maxScope: 'system'` key has no tenant row it could ever honour, so it
      // contributes NO tenant cells. The screen renders the row with its tenant
      // columns disabled - better than offering a checkbox whose value the
      // cascade would ignore.
      if (descriptor.maxScope === 'system') continue;
      for (const tenant of tenants) cells.push(this.cellFor(descriptor, tenant.id, rows));
    }

    return { features, tenants, cells };
  }

  /**
   * Apply a batch of matrix edits.
   *
   * -- WHY PER-CELL ERRORS AND NOT ONE ATOMIC BATCH -------------------------
   * Each cell is a distinct `GlobalSetting` row under a distinct tenant, written
   * through the same governed OCC lane as a single-key PUT - which means each
   * carries its OWN precondition. Failing the whole save because ONE cell
   * drifted would discard a screenful of unrelated, valid edits and tell the
   * admin nothing about which cell to re-read; and it would not be a transaction
   * anyway, since the lane's cache refresh and its two invalidation publishes
   * are not transactional side effects. So the batch is ORDERED and PARTIAL:
   * every cell that can be applied is, and the ones that could not come back
   * individually with the status they would have produced on their own. The
   * caller re-reads and re-applies those.
   *
   * The alternative - bypassing the lane to get a single `$transaction` - would
   * lose the descriptor guards, the sys-events and the invalidation fan-out,
   * which is the entire reason a governed write lane exists.
   */
  async applyMatrix(writes: readonly FeatureMatrixWrite[]): Promise<FeatureMatrixWriteResult> {
    this.assertPlatformMatrixAccess();
    const known = new Set(this.descriptors().map((d) => d.key));

    const errors: FeatureMatrixCellError[] = [];
    for (const cell of writes) {
      if (!known.has(cell.key)) {
        errors.push({ key: cell.key, tenantId: cell.tenantId, status: 400, message: `'${cell.key}' is not a feature-availability setting.` });
        continue;
      }
      try {
        await this.applyCell(cell);
      } catch (error) {
        errors.push({ key: cell.key, tenantId: cell.tenantId, status: statusOf(error), message: messageOf(error) });
      }
    }

    // Re-read AFTER the batch so every returned cell carries the version the
    // caller must echo next time.
    const matrix = await this.readMatrix();
    const touched = new Set(writes.map((w) => rowKey(w.key, w.tenantId)));
    return { cells: matrix.cells.filter((c) => touched.has(rowKey(c.key, c.tenantId))), errors };
  }

  // ----------------------------- internals -----------------------------

  /**
   * One cell edit, routed through the governed write lane so the descriptor
   * guards, the sys-event and both invalidation publishes all happen.
   *
   * The lane targets a TENANT row from CLS (never from a caller-supplied id -
   * see `targetTenantFor`), so a cross-tenant cell is applied by re-entering CLS
   * on that tenant, exactly as `actingOnTenant` does for the SYSTEM row. The
   * privilege check has already happened; this only moves the row pointer.
   */
  private async applyCell(cell: FeatureMatrixWrite): Promise<void> {
    const isPlatform = cell.tenantId === PLATFORM_COLUMN;

    if (isPlatform) {
      // `null` on the PLATFORM column means "back to the descriptor default".
      // It is a WRITE of that value, not a delete: see `reset`'s doc for why the
      // platform row is rewritten and never removed.
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(cell.key);
      const value = cell.value === null ? descriptor.default : cell.value;
      // TASK-932 — idempotent: a platform row that already holds the target value is left
      // alone. The governed lane refuses a write that changes nothing (400 "No changes to
      // write to."), and the matrix surfaced that as a FAILED reset on a cell that was already
      // right. Read the row the way the matrix itself reads it (fresh, unscoped, de-duplicated),
      // so the decision matches what the caller was shown.
      const { rows } = await this.readUnscoped([cell.key]);
      const current = rows.get(rowKey(cell.key, SYSTEM_TENANT_ID));
      if (current && current.value === value) return;
      await this.writeService.write(cell.key, value, {
        scope: 'system',
        ...(cell.expectedVersion === undefined ? {} : { expectedVersion: cell.expectedVersion }),
      });
      return;
    }

    await this.actingOnTenant(cell.tenantId, async () => {
      const options = { scope: 'tenant' as const, ...(cell.expectedVersion === undefined ? {} : { expectedVersion: cell.expectedVersion }) };
      if (cell.value === null) {
        await this.writeService.reset(cell.key, options);
        return;
      }
      await this.writeService.write(cell.key, cell.value, options);
    });
  }

  /**
   * SUPER_ADMIN only, imperatively - there is no "super admin" CASL subject, and
   * a tenant admin legitimately holds `manage:GlobalSetting` for its own rows.
   * A 403 (privilege), never the cross-tenant 404: nothing about a matrix of
   * platform features is a per-row existence question.
   */
  private assertPlatformMatrixAccess(): void {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException(
        'The feature-availability matrix is cross-tenant platform configuration and is restricted to super administrators.',
      );
    }
  }

  /** Tenants (SYSTEM excluded) + every stored feature row, read across tenants. */
  private async readUnscoped(keys: string[]): Promise<{ tenants: FeatureMatrixTenant[]; rows: Map<string, { value: unknown; version: number }> }> {
    return this.withoutTenantContext(async () => {
      const tenantEntities = (await this.tenantRepository.findAll({ where: {} } as never)) as unknown as Array<{
        id: string;
        name?: string;
        key?: string;
      }>;
      const tenants = tenantEntities
        .filter((t) => t.id !== SYSTEM_TENANT_ID)
        .map((t) => ({ id: t.id, name: t.name ?? t.key ?? t.id, slug: t.key ?? t.id }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // TASK-932 — NAMESPACE-AGNOSTIC, then de-duplicated by `pickBackingRow`:
      // the same rule the write lane's `findBackingRow` applies. These cells are
      // handed straight back to `writeService.write` as the `expectedVersion`,
      // so a matrix that read a DIFFERENT row than the write lane adopts reports
      // version 0 and then 428s on save. Filtering to the `registry` namespace
      // here did exactly that for any key whose row a seed created elsewhere.
      const settingRows = keys.length
        ? ((await this.globalSettingRepository.findAll({ where: { key: { in: keys } } } as never)) as unknown as Array<MatrixRow>)
        : [];

      const candidates = new Map<string, MatrixRow[]>();
      for (const row of settingRows) {
        const id = rowKey(row.key, row.tenantId);
        const bucket = candidates.get(id);
        if (bucket) bucket.push(row);
        else candidates.set(id, [row]);
      }

      const rows = new Map<string, { value: unknown; version: number }>();
      for (const [id, bucket] of candidates) {
        const row = pickBackingRow(bucket)!;
        rows.set(id, { value: row.parsedValue ?? row.value, version: row.version });
      }
      return { tenants, rows };
    });
  }

  private cellFor(descriptor: SettingDescriptor, column: string, rows: Map<string, { value: unknown; version: number }>): FeatureMatrixCell {
    const tenantId = column === PLATFORM_COLUMN ? SYSTEM_TENANT_ID : column;
    const row = rows.get(rowKey(descriptor.key, tenantId));
    if (!row) {
      // The PLATFORM column always reports a value - the descriptor default is
      // what every tenant inherits when no row exists, so rendering it as
      // "inherits" would leave the column blank with nothing above it.
      return {
        key: descriptor.key,
        tenantId: column,
        value: column === PLATFORM_COLUMN ? descriptor.default === true : null,
        version: 0,
      };
    }
    return { key: descriptor.key, tenantId: column, value: toBoolean(row.value), version: row.version };
  }

  /** Run `work` with the SAME user but no tenant in CLS - the unscoped read window. */
  private withoutTenantContext<T>(work: () => Promise<T>): Promise<T> {
    const user = this.cls.get('user');
    return this.cls.run(async () => {
      if (user) this.cls.set('user', user);
      this.cls.set('tenantId', undefined as never);
      return work();
    });
  }

  /** Run `work` with the SAME user and `tenantId` in CLS - the write window for one cell. */
  private actingOnTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const user = this.cls.get('user');
    return this.cls.run(async () => {
      if (user) this.cls.set('user', user);
      this.cls.set('tenantId', tenantId);
      return work();
    });
  }
}

const rowKey = (key: string, tenantId: string): string => `${tenantId} ${key}`;

/** One `GlobalSetting` row as the matrix reads it — `AdoptableRow` supplies the fields `pickBackingRow` needs. */
type MatrixRow = AdoptableRow & { key: string; tenantId: string; parsedValue?: unknown; value?: unknown; version: number };

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * The status a cell's failure would have produced as a single-key request. Read
 * off the exception the write lane already raises, so the batch reports the SAME
 * contract the per-key route does rather than inventing a second one.
 */
function statusOf(error: unknown): number {
  const status = (error as { getStatus?: () => number })?.getStatus?.();
  if (typeof status === 'number') return status;
  const name = (error as { name?: string })?.name ?? '';
  if (name.includes('OptimisticConcurrency')) return 412;
  if (error instanceof ArgumentInvalidException) return 400;
  return 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
