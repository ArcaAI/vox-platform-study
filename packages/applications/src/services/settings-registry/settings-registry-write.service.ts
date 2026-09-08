import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { GlobalSettingRepository, ResourceType, SysEventType, ValueType } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IGlobalSettingService } from '../globalSetting/IGlobalSettingService';
import { IRedisCacheService } from '../baseServices/redis';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import { SettingDataType, SettingDescriptor, SettingScope } from './registry.types';
import { SETTING_TIER_LOCKED, settingLockFor } from './setting-lock';
import { assertTightenOnlyFloor } from './tenant-clamp';

/**
 * The reserved namespace for registry-lane writes. Keeps this lane's rows
 * distinct from the pre-existing `GlobalSettingController` row CRUD (same
 * table, two write paths) until that legacy surface is reconciled.
 */
export const REGISTRY_SETTING_NAMESPACE = 'registry';

/**
 * The Redis pub/sub channel the PYTHON services watch for config invalidation
 * (RC-6).
 *
 * WHY ONE GENERALISED CHANNEL, NOT SIX. Before this, the only Python-facing
 * channel was `arca:guardrail-config:invalidate`, which appeared exactly once
 * repo-wide — guardrail's SUBSCRIBER, with ZERO publishers. Guardrail believed
 * it had push invalidation and actually had a 60s TTL poll, and the other five
 * services never had a listener at all. Rule 09 makes the
 * ordering explicit: "Invalidation is the propagation path; TTL is a
 * bounded-staleness safety net." A per-service channel would multiply the
 * publish fan-out by the service count for a payload every service can filter
 * itself, and would need this write lane to know which services consume which
 * key — a mapping that already lives in `SettingDescriptor.consumedBy` and must
 * not get a second, drifting definition here. One channel, every Python pull
 * client subscribed, each dropping its own snapshot.
 *
 * DISTINCT FROM the two channels that already exist, on purpose:
 *   • `app-settings:invalidate` converges GATEWAY nodes' `AppSettingsService`
 *     caches. Its payload is `{ instanceId }` — a self-publish filter, carrying
 *     no key — so it cannot tell a Python client WHAT changed.
 *   • `arca:secrets:invalidate` evicts per-key SECRETS. Secrets never traverse
 *     this lane at all (guard 2 of `write()`).
 *
 * PAYLOAD: `{ key, scope, tenantId }` — the canonical dotted registry key, the
 * scope written at, and the row's tenant. Never a VALUE: a subscriber refetches
 * through the authenticated `/internal/effective-config` route, so the channel
 * carries no configuration and needs no trust.
 */
export const PYTHON_CONFIG_INVALIDATION_CHANNEL = 'arca:config:invalidate';

/**
 * The reserved SYSTEM tenant. Platform-owned KV rows (rate-limit.*, and every
 * other `global-kv` row written at `system` scope) live here — the SOLE
 * platform-configuration tier (owner ruling 2026-08-20).
 * GLOBAL (`50000000-…`) is a CUSTOMER tenant, never a config tier: it must
 * never be the target of a `system`-scope write.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Tenants that own PLATFORM configuration. A `tenant`-scope write may never
 * target one of these: it would land in the key-only (platform) lane of the
 * settings cache and silently become a platform-wide change (that
 * lane is sound only because its contents are platform-only). Mirrors
 * `PLATFORM_TENANT_IDS` in `AppSettingsService`.
 */
const PLATFORM_TENANT_IDS: readonly string[] = [SYSTEM_TENANT_ID];

export interface WriteRegistrySettingOptions {
  /** Scope the value is being set at. Defaults to `system` for global-kv keys. */
  scope?: SettingScope;
  /**
   * The row version the caller last observed, folded from
   * `If-Match` by the controller (house pattern). REQUIRED when a backing row
   * already exists: without it the write is refused 428 rather than blindly
   * overwriting a concurrent edit. Absent on a FIRST write, where there is no
   * version to match.
   */
  expectedVersion?: number;
}

/** Outcome of {@link SettingsRegistryWriteService.reset}. */
export interface ResetRegistrySettingResult {
  key: string;
  tier: string;
  scope: SettingScope;
  /** `false` when there was no override to remove — a no-op, not a failure. */
  removed: boolean;
}

export interface WriteRegistrySettingResult {
  key: string;
  tier: string;
  value: unknown;
  scope: SettingScope;
  /**
   * The row version AFTER this write. Echoed so the caller can use
   * it as the next `If-Match`, and so the `ETagInterceptor` renders an ETag on
   * this response (it keys off a top-level positive-integer `version`).
   */
  version: number;
}

/**
 * The settings WRITE LANE (a single enforcement point).
 *
 * Before this service there was no write route for ANY registry key anywhere in
 * the gateway: descriptors declared `globalOnly` / `editableBy` / `maxScope`,
 * and nothing consumed them. `SettingsRegistry.assertWithinMaxScope` had ZERO
 * production callers (the pipeline-policy service re-implemented the clamp by
 * hand). This service is its first.
 *
 * Every guard below reads DESCRIPTOR METADATA — there is deliberately no
 * per-key allow-list in this file, so registering a new descriptor is the only
 * thing needed to make a key governed and writable.
 *
 * The PUT flow, in order:
 *   1. unknown key → 400
 *   2. `sensitivity === 'secret'` → 400 (secrets never flow through this lane)
 *   3. `globalOnly` + not super admin → 403
 *   4. `assertWithinMaxScope` → 400 on a too-deep scope
 *   5. tier dispatch → 400 for anything but `global-kv`
 *   6. value validated against `dataType`
 *   6b. descriptor-declared `validate` invariant (ordering / cross-field) → 400
 *   7. upsert the backing row, broadcast a sys-event, refresh the read cache
 */
@Injectable()
export class SettingsRegistryWriteService extends BaseService {
  private readonly logger = new Logger(SettingsRegistryWriteService.name);

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    @Inject(IGlobalSettingService) private readonly globalSettings: IGlobalSettingService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Direct repository access for a FRESH row read. The CAS
    // version must never come from the AppSettings snapshot: that map is rebuilt
    // on a 45s cron, so two admins editing inside one window would compare
    // against the same stale number and the second would silently clobber the
    // first. Reading the row here costs one indexed lookup per write.
    private readonly globalSettingRepository: GlobalSettingRepository,
    // The publish half of RC-6. `@Optional()` for the same reason
    // `AppSettingsService` takes it optionally: a service graph assembled
    // without the Redis module (unit tests, CLI tooling) must still be able to
    // WRITE a setting — propagation degrades to each Python client's TTL
    // backstop, which is exactly the pre-existing behaviour.
    @Optional() @Inject(IRedisCacheService) private readonly redisCacheService?: IRedisCacheService,
  ) {
    super(eventEmitter, clsService, ResourceType.GlobalSetting);
  }

  async write(key: string, value: unknown, options: WriteRegistrySettingOptions = {}): Promise<WriteRegistrySettingResult> {
    // 1. Unknown key. `getOrThrow` throws a bare Error, so translate it into
    //    the domain exception the filters map to 400.
    const descriptor = this.getDescriptorOrThrow(key);

    // 2. Secrets never traverse this lane — mirrors the same refusal in
    //    `EffectiveSettingsService.resolveEffective`.
    if (descriptor.sensitivity === 'secret') {
      throw new ArgumentInvalidException(`Setting '${key}' is a secret; secret values are never written through the settings registry lane.`);
    }

    // 3. Privilege boundary, DESCRIPTOR-DRIVEN. 403 not 404: the caller can
    //    already READ this key through the catalog; only the write is gated.
    if (descriptor.globalOnly && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Setting '${key}' is managed by super administrators only.`);
    }

    // 4. The max-scope clamp — THE enforcement point (first production caller).
    const scope: SettingScope = options.scope ?? 'system';
    HOPE_SETTINGS_REGISTRY.assertWithinMaxScope(key, scope);

    // 4b. WHICH ROW this write targets. `globalOnly` gates the
    //     KEY; this gates the SCOPE, and the two are independent: a key a tenant
    //     admin may set for ITSELF (`rateLimit.maxRequests`) is still a
    //     platform-wide change when written at `system` scope. Previously a
    //     `scope: 'tenant'` write passed the clamp and then wrote the PLATFORM
    //     row regardless — the clamp said yes and the value landed in the wrong
    //     place.
    this.assertMayWriteAtScope(scope, key);
    const targetTenantId = this.targetTenantFor(scope, key);

    // 4c. LOCKED tiers (TASK-932 R-6 / D-6). Bootstrap, credential and
    //     data-plane transport values are un-editable for EVERY caller, a super
    //     administrator included — the owner's words, and the half a UI-only
    //     rule cannot deliver.
    //
    //     It runs BEFORE the tier dispatch below, and the ordering is the whole
    //     point: both refusals are 400s, but they say different things. "Not
    //     writable through the registry lane (yet) — its dedicated service owns
    //     it" is true of `db-config` and is an invitation to go and edit it
    //     somewhere else. For `env` / `vault-kv` / `db-secret` that sentence is
    //     FALSE — there is no other screen — so the generic message would send
    //     an admin looking for a surface that does not exist. The lock is
    //     derived from descriptor metadata, never a key list (`setting-lock.ts`).
    this.assertNotLocked(descriptor);

    // 5. Tier dispatch. `db-config` keys (pipeline policy, TTS config) keep
    //    their dedicated services until those adopt this enforcement point;
    //    refusing here is deliberate, not an oversight.
    if (descriptor.tier !== 'global-kv') {
      throw new ArgumentInvalidException(
        `Tier '${descriptor.tier}' is not writable through the registry lane (yet). ` + `Setting '${key}' is managed by its dedicated service.`,
      );
    }

    // 6. Type validation against the declared dataType.
    const { serialized, valueType } = this.serialize(descriptor, value);

    // 6b. The descriptor's own INVARIANT, for keys that DECLARE one
    //     (`descriptor.validate`). Runs here and not earlier because an invariant may only be
    //     handed a value already known to be well-typed — step 6 is what establishes that.
    //
    //     WHY THIS IS NOT AN `if (key === …)`. `dataType` classifies a value's SHAPE and cannot
    //     express a relationship between its entries, which is exactly where the consultation
    //     endpoint sequence goes wrong: five valid keys in an order that locks the consultation's
    //     documents before the step that writes the note into them. The rule belongs to the KEY,
    //     so it is declared on the key's descriptor and enforced generically here — registering a
    //     descriptor stays the only thing needed to govern a setting.
    //
    //     The descriptor's message IS the admin's explanation; it is passed through verbatim.
    const invariantProblem = descriptor.validate?.(value);
    if (invariantProblem) {
      throw new ArgumentInvalidException(`Setting '${key}' was refused: ${invariantProblem}`);
    }

    // 6c. The tighten-only floor, for keys that DECLARE one
    //     (`descriptor.floorDirection`). A tenant-scope write may move such a
    //     key towards more safety and nowhere else; a loosening write is
    //     REJECTED (403), never silently clamped, so an admin is told rather
    //     than left believing they set something they did not.
    //
    //     Only a `tenant`-scope write is floored: a `system`-scope write IS the
    //     platform value, so there is nothing above it to be measured against
    //     (and it is already SUPER_ADMIN-only via `assertMayWriteAtScope`).
    //
    //     Descriptor-driven like every other guard here — this is one call, not
    //     a per-feature branch. `guardrail.policy.*` is the first consumer; its
    //     own `assertGuardrailPolicyFloor` expressed exactly this policy and had
    //     ZERO callers, which is what wiring it generically fixes.
    //
    //     The floor is read ONLY for a key that declares a direction — for every
    //     other key the guard would be a no-op, so resolving a floor first would
    //     be a cache read per write that can never change the outcome.
    if (scope !== 'system' && descriptor.floorDirection) {
      assertTightenOnlyFloor(descriptor, value, this.platformFloorFor(descriptor));
    }

    // 7. Upsert the backing row under COMPARE-AND-SET, then refresh the read cache.
    const existing = await this.findBackingRow(key, targetTenantId);
    const persisted = await this.actingOnTenant(targetTenantId, () =>
      existing
        ? this.updateExisting(existing, serialized, options.expectedVersion, key)
        : this.createOrRecoverRace(key, descriptor, serialized, valueType, targetTenantId),
    );

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: persisted.id,
      data: {
        key,
        scope,
        tier: descriptor.tier,
        namespace: REGISTRY_SETTING_NAMESPACE,
        tenantId: targetTenantId,
        newVersion: persisted.version,
      },
    });

    await this.appSettings.refreshCache();

    // The PYTHON half of propagation (RC-6). Published LAST, after the row is
    // committed AND the gateway's own read cache has been refreshed: a
    // subscriber refetches `/internal/effective-config` immediately on receipt,
    // and that route reads through `AppSettingsService`. Publishing earlier
    // would race the refetch against the stale snapshot and could re-cache the
    // OLD value for a full TTL — the exact failure this channel exists to
    // remove.
    await this.publishPythonInvalidation(key, scope, targetTenantId);

    return { key, tier: descriptor.tier, value, scope, version: persisted.version };
  }

  /**
   * The LOCK guard — 400 for every caller, including a super administrator.
   *
   * The message carries the machine-readable {@link SETTING_TIER_LOCKED} marker
   * so a client can branch on the KIND of refusal rather than on prose, and the
   * descriptor's own reason so the admin is told where the value actually
   * changes instead of only that it did not.
   */
  private assertNotLocked(descriptor: SettingDescriptor): void {
    const lock = settingLockFor(descriptor);
    if (!lock) return;
    throw new ArgumentInvalidException(`${SETTING_TIER_LOCKED}: setting '${descriptor.key}' is not editable (${lock.label}). ${lock.reason}`);
  }

  /**
   * RESET one TENANT override back to the inherited value.
   *
   * ── WHY A DELETE AND NOT A WRITE ──────────────────────────────────────────
   * "Reset to the platform default" means the tenant stops holding an opinion,
   * so the cascade resumes: `tenant → SYSTEM → descriptor default`. Writing the
   * platform's CURRENT value into the tenant row would look identical today and
   * diverge silently the next time a platform admin moves the default — the
   * tenant would be pinned to a stale copy nobody remembers choosing. Removing
   * the row is the only thing that actually restores inheritance.
   *
   * The removal is a SOFT delete, like every other row in this platform. Both
   * readers that matter agree with that: the Prisma soft-delete extension
   * filters `resourceStatus: DELETED` out of `AppSettingsService`'s cache load
   * (so the cascade falls through immediately) and out of `findBackingRow` (so a
   * later write CREATES again — and `createOrRecoverRace` already revives over
   * the soft-delete unique index).
   *
   * ── WHY `system` SCOPE IS REFUSED ─────────────────────────────────────────
   * There is no tier above SYSTEM to inherit from. Deleting the platform row
   * would not "reset" anything — it would drop the platform to the descriptor's
   * code default, which is a DIFFERENT and usually a fail-safe value (a
   * kill-switch's OFF). That is a legitimate thing to want, and it is a WRITE of
   * `descriptor.default`, stated as such and versioned as such — the matrix's
   * `value: null` on the platform column does exactly that. Silently overloading
   * DELETE with it would make one verb mean two things.
   *
   * Every guard from {@link write} applies unchanged and in the same order,
   * because a reset changes the effective value exactly as a write does.
   */
  async reset(key: string, options: WriteRegistrySettingOptions = {}): Promise<ResetRegistrySettingResult> {
    const descriptor = this.getDescriptorOrThrow(key);

    if (descriptor.sensitivity === 'secret') {
      throw new ArgumentInvalidException(`Setting '${key}' is a secret; secret values are never written through the settings registry lane.`);
    }
    if (descriptor.globalOnly && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Setting '${key}' is managed by super administrators only.`);
    }

    const scope: SettingScope = options.scope ?? 'tenant';
    if (scope === 'system') {
      throw new ArgumentInvalidException(
        `Setting '${key}' cannot be RESET at 'system' scope: the platform row is the top of the cascade, so there is nothing above it to inherit. ` +
          'Write the descriptor default explicitly instead.',
      );
    }
    HOPE_SETTINGS_REGISTRY.assertWithinMaxScope(key, scope);
    this.assertMayWriteAtScope(scope, key);
    this.assertNotLocked(descriptor);
    if (descriptor.tier !== 'global-kv') {
      throw new ArgumentInvalidException(
        `Tier '${descriptor.tier}' is not writable through the registry lane (yet). ` + `Setting '${key}' is managed by its dedicated service.`,
      );
    }

    const targetTenantId = this.targetTenantFor(scope, key);
    const existing = await this.findBackingRow(key, targetTenantId);

    // Already inheriting. Idempotent by design: a "reset all tenants" sweep must
    // not fail on the tenants that never had an override in the first place.
    if (!existing) {
      return { key, tier: descriptor.tier, scope, removed: false };
    }

    // Same precondition contract as `updateExisting`: a caller that read the row
    // must say which version it saw, or a concurrent edit is destroyed silently.
    // A reset with NO `expectedVersion` is accepted — unlike a write — because
    // the batch matrix save resets cells the caller never opened, and the
    // outcome (the row is gone) does not depend on what it contained.
    if (options.expectedVersion !== undefined && existing.version !== options.expectedVersion) {
      throw new OptimisticConcurrencyException('GlobalSetting', existing.id, {
        expectedVersion: options.expectedVersion,
        currentVersion: existing.version,
      });
    }

    await this.actingOnTenant(targetTenantId, () => this.globalSettings.deleteById(existing.id));

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: existing.id,
      data: { key, scope, tier: descriptor.tier, namespace: REGISTRY_SETTING_NAMESPACE, tenantId: targetTenantId, reset: true },
    });

    await this.appSettings.refreshCache();
    await this.publishPythonInvalidation(key, scope, targetTenantId);

    return { key, tier: descriptor.tier, scope, removed: true };
  }

  /**
   * Notify the Python pull clients that `key` changed. FAIL-OPEN by
   * construction: the row is already committed, so a Redis outage may only
   * delay propagation to each client's TTL backstop — it must never turn a
   * successful write into an error the admin sees.
   */
  private async publishPythonInvalidation(key: string, scope: SettingScope, tenantId: string): Promise<void> {
    if (!this.redisCacheService) {
      return;
    }

    try {
      await this.redisCacheService.publish(PYTHON_CONFIG_INVALIDATION_CHANNEL, JSON.stringify({ key, scope, tenantId }));
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish Python config invalidation (fail-open — each service TTL still converges)',
        channel: PYTHON_CONFIG_INVALIDATION_CHANNEL,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The PLATFORM value a tenant write is floored against: the stored SYSTEM row
   * if one exists, otherwise the descriptor's code default.
   *
   * Read from the settings cache rather than the repository ON PURPOSE — unlike
   * the OCC version (which must be fresh, see the constructor note), the floor
   * is a POLICY bound. A floor read from a snapshot at most 45s old can only
   * differ from the live one when a platform admin has just moved the floor,
   * and the invalidation publish makes that window smaller still.
   */
  private platformFloorFor(descriptor: SettingDescriptor): unknown {
    const stored = this.appSettings.getValueFromCache(descriptor.key);
    return stored !== null && stored !== undefined ? stored : descriptor.default;
  }

  /**
   * Current version of the backing row for `key`, or 0 when none is stored yet.
   *
   * Public so the READ route can carry it, letting the `ETagInterceptor` render
   * an ETag the client echoes as `If-Match` on the write. 0 deliberately yields
   * no ETag — there is nothing to precondition a first write against.
   */
  async getBackingRowVersion(key: string, scope: SettingScope = 'system'): Promise<number> {
    // Deliberately does NOT assert the write privilege: rendering an ETag is a
    // READ, and a tenant admin must be able to read the version of a key it is
    // allowed to write. A tenant-scope read with no working tenant reports "no
    // row" rather than erroring — a GET must not 400 because the caller has not
    // picked a tenant yet.
    let tenantId: string;
    try {
      tenantId = this.targetTenantFor(scope, key);
    } catch {
      return 0;
    }
    const row = await this.findBackingRow(key, tenantId);
    return row?.version ?? 0;
  }

  /**
   * The privilege boundary on the SCOPE of a write.
   *
   * A `system`-scope write changes the value platform-wide, so it is
   * SUPER_ADMIN-ONLY regardless of `globalOnly` — which gates the KEY, not the
   * scope. This is a 403 (privilege), never the 404-over-403 cross-tenant
   * posture: the caller may legitimately hold `manage` on the key for its OWN
   * tenant, and is being refused only the platform-wide row.
   *
   * Kept SEPARATE from `targetTenantFor` so a read path can resolve which row
   * it is looking at without inheriting a write's privilege check.
   */
  private assertMayWriteAtScope(scope: SettingScope, key: string): void {
    if (scope === 'system' && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Writing setting '${key}' at 'system' scope changes it platform-wide and is restricted to super administrators.`);
    }
  }

  /**
   * The tenant whose row `scope` addresses. Pure row targeting — no privilege
   * check (see `assertMayWriteAtScope`).
   *
   *  - `system` → the reserved platform tenant.
   *  - `tenant` → the caller's WORKING tenant, taken from CLS. Deliberately
   *    not a caller-supplied id: the Prisma tenant-scope extension pins every
   *    `GlobalSetting` write to the CLS tenant anyway, so accepting a target id
   *    here would advertise a cross-tenant write path that cannot execute. A
   *    super admin acting for a tenant already carries that tenant in CLS (the
   *    console's `X-Tenant-Id` working-tenant header).
   *
   * `department` / `doctor` are refused: no key declares a deeper `maxScope`
   * than `tenant` in this tier, and inventing a row layout for a scope with no
   * descriptor would be speculative.
   */
  private targetTenantFor(scope: SettingScope, key: string): string {
    if (scope === 'system') {
      return SYSTEM_TENANT_ID;
    }
    if (scope !== 'tenant') {
      throw new ArgumentInvalidException(`Setting '${key}' cannot be written at '${scope}' scope through the registry lane.`);
    }

    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException(`Writing setting '${key}' at 'tenant' scope requires a working tenant; none is selected for this request.`);
    }
    if (PLATFORM_TENANT_IDS.includes(tenantId)) {
      throw new ArgumentInvalidException(
        `Writing setting '${key}' at 'tenant' scope requires a CUSTOMER tenant; ` +
          'the reserved platform tenants hold the platform-wide row, which is written at `system` scope.',
      );
    }
    return tenantId;
  }

  /**
   * Run the persistence for `targetTenantId` with CLS actually pointing at that
   * tenant.
   *
   * A super admin's WORKING tenant rides in CLS on every console request, and
   * the tenant-scope extension pins every `GlobalSetting` write to it —
   * deliberately: reads widen to `[caller, SYSTEM]`, writes never do
   * (`packages/database/src/extensions/tenant-scope.ts`). So a `system`-scope
   * write while any customer tenant was selected threw
   * `TenantScope: tenantId mismatch on GlobalSetting.create` and surfaced as a
   * 500 — i.e. the platform row was unwritable from the console's normal state.
   *
   * The same defect and its two remedies are documented on
   * `AiTaskDefaultService.crossTenantLane`, which routes the write through the
   * UNSCOPED base client. This lane cannot: it persists through
   * `IGlobalSettingService`, whose `create`/`update` carry semantics worth
   * keeping (revive-on-create over the soft-delete unique index, the
   * locked-row SUPER_ADMIN guard, secret re-wrap, sys-events) and take no `tx`
   * client. Re-entering CLS on the target tenant reaches the same row without
   * forking those semantics, and matches `resolveNerModelInjection`'s
   * `cls.run()` + `set('tenantId', SYSTEM_TENANT_ID)` precedent.
   *
   * The nested context carries the SAME user, so audit attribution
   * (`createdBy`/`updatedBy`) and every `isSuperAdmin(this.requestUser)` check
   * downstream behave exactly as they do on the caller's own tenant. This does
   * NOT widen any privilege: `assertMayWriteAtScope` has already refused a
   * non-super-admin `system` write with a 403 before we get here.
   */
  private async actingOnTenant<T>(targetTenantId: string, work: () => Promise<T>): Promise<T> {
    if (targetTenantId === this.tenantId) {
      return work();
    }
    const user = this.requestUser;
    return this.clsService.run(async () => {
      this.clsService.set('tenantId', targetTenantId);
      if (user) this.clsService.set('user', user);
      return work();
    });
  }

  /**
   * The backing KV row for `key` under `tenantId`, read FRESH (never the
   * AppSettings snapshot).
   */
  private async findBackingRow(key: string, tenantId: string): Promise<{ id: string; version: number } | null> {
    // `Repository.findFirst` THROWS `DataNotFoundException` on no match (it
    // never returns null) — on a fresh DB with no registry rows that exception
    // used to escape as a blanket 404 on every `GET registry/:key`.
    // "No backing row yet" is a normal state here (code-default /
    // first write), so it maps to null, not an error.
    try {
      const row = await this.globalSettingRepository.findFirst({
        where: { key, namespace: REGISTRY_SETTING_NAMESPACE, tenantId },
      } as never);
      return row ? { id: row.id, version: row.version } : null;
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * CAS an existing row. `expectedVersion` is mandatory here — a write with no
   * precondition against a row that already exists is exactly the blind
   * overwrite RFC 7232 defines 428 for.
   */
  private async updateExisting(
    existing: { id: string; version: number },
    serialized: string,
    expectedVersion: number | undefined,
    key: string,
  ): Promise<{ id: string; version: number }> {
    if (expectedVersion === undefined) {
      // RFC 6585 §3 — mirrors the shape `extractExpectedVersion` throws at the
      // HTTP layer, so a caller sees one consistent 428 contract whether the
      // header was omitted on an annotated route or reached the service unset.
      throw new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_REQUIRED,
          code: 'HTTP.PRECONDITION_REQUIRED',
          message:
            `Setting '${key}' already has a stored value (version ${existing.version}). ` +
            `Re-read it and supply If-Match: "<version>" so a concurrent edit cannot be silently overwritten.`,
        },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    // Fail the drift here rather than at the repository so the caller gets the
    // observed-vs-expected pair without a wasted write attempt. The repository's
    // own `updateWithVersion` remains the authoritative guard against a race
    // between this read and the update.
    if (existing.version !== expectedVersion) {
      // Same exception the repository's `updateWithVersion` raises, so the
      // global filter renders the identical 412 body (`{expectedVersion,
      // currentVersion}`) the SDK/UI conflict handler already consumes.
      throw new OptimisticConcurrencyException('GlobalSetting', existing.id, {
        expectedVersion,
        currentVersion: existing.version,
      });
    }
    const updated = await this.globalSettings.update(existing.id, { value: serialized, expectedVersion });
    return { id: updated.id, version: updated.version };
  }

  /**
   * First write. Two writers can both observe "no row", so a unique-constraint
   * failure is a LOST RACE, not an error: re-read and update instead of handing
   * the loser a 500.
   */
  private async createOrRecoverRace(
    key: string,
    descriptor: SettingDescriptor,
    serialized: string,
    valueType: ValueType,
    tenantId: string,
  ): Promise<{ id: string; version: number }> {
    try {
      const created = await this.globalSettings.create({
        name: descriptor.label ?? key,
        key,
        value: serialized,
        dataType: valueType,
        namespace: REGISTRY_SETTING_NAMESPACE,
        tenantId,
      });
      return { id: created.id, version: created.version };
    } catch (error) {
      const winner = await this.findBackingRow(key, tenantId);
      if (!winner) throw error;
      const updated = await this.globalSettings.update(winner.id, { value: serialized, expectedVersion: winner.version });
      return { id: updated.id, version: updated.version };
    }
  }

  // ────────────────────────────── internals ──────────────────────────────

  private getDescriptorOrThrow(key: string): SettingDescriptor {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    if (!descriptor) {
      throw new ArgumentInvalidException(`Unknown setting '${key}'.`);
    }
    return descriptor;
  }

  /**
   * Validate the incoming value against the descriptor's declared type and
   * project it onto the `GlobalSetting.value` (string) + `dataType` columns the
   * AppSettings cache parses back out.
   */
  private serialize(descriptor: SettingDescriptor, value: unknown): { serialized: string; valueType: ValueType } {
    const { key, dataType } = descriptor;

    switch (dataType satisfies SettingDataType) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new ArgumentInvalidException(`Setting '${key}' expects a boolean (got ${typeof value}).`);
        }
        return { serialized: String(value), valueType: ValueType.Boolean };

      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new ArgumentInvalidException(`Setting '${key}' expects a number (got ${typeof value}).`);
        }
        return {
          serialized: String(value),
          valueType: Number.isInteger(value) ? ValueType.Integer : ValueType.Float,
        };
      }

      case 'string':
      case 'enum':
        if (typeof value !== 'string') {
          throw new ArgumentInvalidException(`Setting '${key}' expects a string (got ${typeof value}).`);
        }
        return { serialized: value, valueType: ValueType.String };

      case 'string[]':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          throw new ArgumentInvalidException(`Setting '${key}' expects an array of strings.`);
        }
        return { serialized: JSON.stringify(value), valueType: ValueType.Array };

      case 'json':
        if (value === null || typeof value !== 'object') {
          throw new ArgumentInvalidException(`Setting '${key}' expects a JSON object.`);
        }
        return { serialized: JSON.stringify(value), valueType: ValueType.Json };

      case 'secret':
        // Unreachable — step 2 already refused secret sensitivity. Kept so the
        // switch stays exhaustive if a non-secret-sensitivity descriptor ever
        // declares a secret dataType.
        throw new ArgumentInvalidException(`Setting '${key}' is a secret and cannot be written through this lane.`);
    }
  }
}
