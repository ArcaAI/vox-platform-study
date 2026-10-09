// Action confirmations (TASK-1057) — resolve and enforce the platform policy that decides whether
// an admin action demands a reason / evidence / acknowledgement before it runs, and produce the
// audit stamp every such action records — including "reason not required".
//
// Consumers (one per confirmable action):
//
//   const stamp = this.confirmations.assert('promptTemplate.update', { value: dto.changeReason });
//   …mutate…
//   this.broadcastSysEvent(SysEventType.ResourceUpdated, { …, metaData: { …, confirmation: stamp } });
//
// An action with its OWN refusal shape (model residency's 409 `LIVE_PATH_REASON_REQUIRED`, the
// restore's `RESTORE_REASON_INVALID`, the schema's `SCHEMA_IMPACT_UNACKNOWLEDGED`) calls `decide`
// — never throws — and raises its own error when `stamp.required && !stamp.provided`.
//
// The mode is resolved on the PLATFORM lane only (`resolve(key, null)`): the switch is SYSTEM-tier,
// owner decision 2026-10-09. Locked catalogue rows have no setting and are always `required`.

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { GlobalSettingRepository } from '@arcaai/domains';
import {
  ACTION_CONFIRMATION_CATALOGUE,
  type ActionConfirmationAuditStamp,
  type ActionConfirmationSpec,
  CONFIRMATION_REQUIRED_CODE,
  type ConfirmationMode,
  type EffectiveActionConfirmation,
  actionConfirmationSettingKey,
  findActionConfirmation,
} from '@arcaai/types';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { type AdoptableRow, SettingsRegistryWriteService, pickBackingRow } from './settings-registry-write.service';
import { TenantSettingsService } from './tenant-settings.service';

/** The reserved platform-configuration tier. Never a customer tenant. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** One catalogue row on the platform screen: spec fields + effective mode + provenance + OCC version. */
export interface ActionConfirmationPlatformRow {
  actionId: string;
  domain: string;
  label: string;
  kind: ActionConfirmationSpec['kind'];
  audience: ActionConfirmationSpec['audience'];
  enforcement: ActionConfirmationSpec['enforcement'];
  default: ConfirmationMode;
  modes: readonly ConfirmationMode[];
  locked: boolean;
  minLength?: number;
  maxLength?: number;
  routes: readonly string[];
  mode: ConfirmationMode;
  source: 'system' | 'default' | 'locked';
  /** Backing SYSTEM row version, read fresh; 0 when no row is stored. */
  version: number;
}

export interface ActionConfirmationPlatformWrite {
  actionId: string;
  /** `null` = reset to the catalogue default. */
  mode: ConfirmationMode | null;
  expectedVersion?: number;
}

export interface ActionConfirmationPlatformError {
  actionId: string;
  status: number;
  message: string;
}

export interface ActionConfirmationPlatformWriteResult {
  rows: ActionConfirmationPlatformRow[];
  /** Per-cell failures; the batch is ordered and partial (see FeatureAvailabilityService.applyMatrix). */
  errors: ActionConfirmationPlatformError[];
}

type StoredRow = AdoptableRow & { key: string; tenantId: string; parsedValue?: unknown; value?: unknown; version: number };

export interface ConfirmationInput {
  /** The caller-supplied value: a reason / evidence string, or `true` for an acknowledgement. */
  value?: unknown;
  /** For `when-risky` rows: whether the action's own risk rule fired for this request. */
  risky?: boolean;
}

const KIND_NOUN: Record<ActionConfirmationSpec['kind'], string> = {
  reason: 'reason',
  evidence: 'evidence reference',
  acknowledgement: 'acknowledgement',
  typeToConfirm: 'typed confirmation',
  reasonCode: 'reason code',
  breakGlass: 'break-glass confirmation',
  stepUp: 'password confirmation',
};

@Injectable()
export class ActionConfirmationService {
  constructor(
    private readonly tenantSettings: TenantSettingsService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly writeService: SettingsRegistryWriteService,
    private readonly globalSettingRepository: GlobalSettingRepository,
  ) {}

  /** The catalogue row for `actionId`; an unknown id is a programming error. */
  spec(actionId: string): ActionConfirmationSpec {
    const spec = findActionConfirmation(actionId);
    if (!spec) throw new Error(`Unknown action confirmation '${actionId}'.`);
    return spec;
  }

  /** The effective mode on the SYSTEM tier (locked rows are always `required`). */
  mode(actionId: string): ConfirmationMode {
    const spec = this.spec(actionId);
    if (spec.locked) return 'required';
    const resolved = this.tenantSettings.resolve<string>(actionConfirmationSettingKey(actionId), null);
    const value = resolved.value;
    return typeof value === 'string' && (spec.modes as readonly string[]).includes(value) ? (value as ConfirmationMode) : spec.default;
  }

  /** Every catalogue row with its effective mode — what the console dialogs read. */
  effective(): EffectiveActionConfirmation[] {
    return ACTION_CONFIRMATION_CATALOGUE.map((spec) => ({
      actionId: spec.actionId,
      kind: spec.kind,
      mode: this.mode(spec.actionId),
      locked: spec.locked === true,
      ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }),
      ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
    }));
  }

  /**
   * Every catalogue row with its effective mode, provenance and FRESH row version — the platform
   * admin's screen. Super administrators only (403). Versions come from the row, never the cache
   * (same reason as the feature matrix: two admins inside one cache window would share a stale version).
   */
  async readPlatform(): Promise<ActionConfirmationPlatformRow[]> {
    this.assertPlatformAccess();
    const rows = await this.readSystemRows();
    return ACTION_CONFIRMATION_CATALOGUE.map((spec) => this.platformRow(spec, rows));
  }

  /**
   * Apply a batch of platform edits, each through the governed write lane (sys-event + cache
   * invalidation). ORDERED and PARTIAL: a refused cell comes back in `errors[]` with the status it
   * would have produced alone. `mode: null` writes the catalogue default (idempotent when the row
   * already holds it, or no row exists).
   */
  async applyPlatform(writes: readonly ActionConfirmationPlatformWrite[]): Promise<ActionConfirmationPlatformWriteResult> {
    this.assertPlatformAccess();
    const errors: ActionConfirmationPlatformError[] = [];
    const touched: string[] = [];
    for (const cell of writes) {
      try {
        await this.applyCell(cell);
        touched.push(cell.actionId);
      } catch (error) {
        errors.push({ actionId: cell.actionId, status: statusOf(error), message: error instanceof Error ? error.message : String(error) });
      }
    }
    const all = await this.readPlatform();
    return { rows: all.filter((r) => touched.includes(r.actionId)), errors };
  }

  private async applyCell(cell: ActionConfirmationPlatformWrite): Promise<void> {
    const spec = findActionConfirmation(cell.actionId);
    if (!spec) throw new BadRequestException(`'${cell.actionId}' is not a confirmable action.`);
    if (spec.locked) throw new BadRequestException(`'${cell.actionId}' is locked and cannot be changed.`);
    const value = cell.mode === null ? spec.default : cell.mode;
    if (!(spec.modes as readonly string[]).includes(value)) {
      throw new BadRequestException(`'${value}' is not an allowed mode for '${cell.actionId}'. Allowed: ${spec.modes.join(', ')}.`);
    }
    const key = actionConfirmationSettingKey(cell.actionId);
    if (cell.mode === null) {
      const current = (await this.readSystemRows()).get(key);
      if (!current || toValue(current) === value) return;
    }
    await this.writeService.write(key, value, {
      scope: 'system',
      ...(cell.expectedVersion === undefined ? {} : { expectedVersion: cell.expectedVersion }),
    });
  }

  private platformRow(spec: ActionConfirmationSpec, rows: Map<string, StoredRow>): ActionConfirmationPlatformRow {
    const base = {
      actionId: spec.actionId,
      domain: spec.domain,
      label: spec.label,
      kind: spec.kind,
      audience: spec.audience,
      enforcement: spec.enforcement,
      default: spec.default,
      modes: spec.modes,
      locked: spec.locked === true,
      ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }),
      ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
      routes: spec.routes,
    };
    if (spec.locked) return { ...base, mode: 'required', source: 'locked', version: 0 };
    const row = rows.get(actionConfirmationSettingKey(spec.actionId));
    const stored = row ? toValue(row) : undefined;
    const valid = typeof stored === 'string' && (spec.modes as readonly string[]).includes(stored);
    return {
      ...base,
      mode: valid ? (stored as ConfirmationMode) : spec.default,
      source: row ? 'system' : 'default',
      version: row ? row.version : 0,
    };
  }

  /** SYSTEM-tier rows, read fresh across the tenant scope (no CLS tenant, same user). */
  private async readSystemRows(): Promise<Map<string, StoredRow>> {
    const keys = ACTION_CONFIRMATION_CATALOGUE.filter((s) => !s.locked).map((s) => actionConfirmationSettingKey(s.actionId));
    const user = this.cls.get('user');
    return this.cls.run(async () => {
      if (user) this.cls.set('user', user);
      this.cls.set('tenantId', undefined as never);
      const found = (await this.globalSettingRepository.findAll({ where: { key: { in: keys }, tenantId: SYSTEM_TENANT_ID } } as never)) as unknown as StoredRow[];
      const buckets = new Map<string, StoredRow[]>();
      for (const row of found) {
        if (row.tenantId !== SYSTEM_TENANT_ID) continue;
        const bucket = buckets.get(row.key);
        if (bucket) bucket.push(row);
        else buckets.set(row.key, [row]);
      }
      const rows = new Map<string, StoredRow>();
      for (const [key, bucket] of buckets) rows.set(key, pickBackingRow(bucket) as StoredRow);
      return rows;
    });
  }

  /** SUPER_ADMIN only; a 403 (privilege) — the platform tier has no existence to hide. */
  private assertPlatformAccess(): void {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Action-confirmation policy is platform configuration and is restricted to super administrators.');
    }
  }

  /** Evaluate the policy for one request. Never throws on a missing value. */
  decide(actionId: string, input: ConfirmationInput = {}): ActionConfirmationAuditStamp {
    const spec = this.spec(actionId);
    const mode = this.mode(actionId);
    const required = mode === 'required' || (mode === 'when-risky' && input.risky === true);
    const provided = isProvided(input.value);
    const noun = KIND_NOUN[spec.kind];
    return {
      actionId,
      kind: spec.kind,
      mode,
      locked: spec.locked === true,
      required,
      provided,
      note: required ? `${noun} required` : `${noun} not required`,
    };
  }

  /**
   * `decide`, then refuse with 400 `CONFIRMATION_REQUIRED` when the policy demands a value the
   * caller did not supply (or a free-text value shorter than the row's `minLength`).
   */
  assert(actionId: string, input: ConfirmationInput = {}): ActionConfirmationAuditStamp {
    const stamp = this.decide(actionId, input);
    if (!stamp.required) return stamp;
    const spec = this.spec(actionId);
    const tooShort = typeof input.value === 'string' && spec.minLength !== undefined && input.value.trim().length < spec.minLength;
    if (!stamp.provided || tooShort) {
      const noun = KIND_NOUN[spec.kind];
      throw new BadRequestException({
        code: CONFIRMATION_REQUIRED_CODE,
        actionId,
        kind: spec.kind,
        ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }),
        message:
          spec.minLength === undefined
            ? `A ${noun} is required for this action.`
            : `A ${noun} of at least ${spec.minLength} characters is required for this action.`,
      });
    }
    return stamp;
  }
}

function isProvided(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return value;
  return value !== undefined && value !== null;
}

function toValue(row: StoredRow): unknown {
  return row.parsedValue ?? row.value;
}

function statusOf(error: unknown): number {
  const status = (error as { getStatus?: () => number })?.getStatus?.();
  if (typeof status === 'number') return status;
  const name = (error as { name?: string })?.name ?? '';
  if (name.includes('OptimisticConcurrency')) return 412;
  if (name.includes('ArgumentInvalid')) return 400;
  return 500;
}
