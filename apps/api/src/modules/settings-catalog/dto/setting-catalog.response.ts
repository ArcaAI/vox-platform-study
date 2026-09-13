import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One entry in the capability/settings catalog. Pure
 * metadata about a controllable setting (never a value); safe to expose.
 */
export class SettingCatalogItemResponse {
  @ApiProperty({ description: 'Canonical dotted key, e.g. rateLimit.maxRequests.' })
  key!: string;

  @ApiProperty({ description: 'Storage tier / §3 data class.', example: 'db-config' })
  tier!: string;

  @ApiProperty({ example: 'boolean' })
  dataType!: string;

  @ApiProperty({ enum: ['public', 'internal', 'secret'], example: 'internal' })
  sensitivity!: string;

  @ApiProperty({ description: 'Deepest scope a tenant admin may set this at.', example: 'tenant' })
  maxScope!: string;

  @ApiProperty({ description: 'CASL subject that gates who may edit it.', example: 'GlobalSetting' })
  editableBy!: string;

  @ApiProperty({ description: 'Server-side taxonomy bucket.', example: 'Pipeline' })
  category!: string;

  @ApiPropertyOptional({ description: 'True = SUPER_ADMIN-only surface.' })
  globalOnly?: boolean;

  @ApiPropertyOptional()
  label?: string;

  @ApiPropertyOptional()
  description?: string;

  // the GOVERNANCE half of a descriptor. Without these the
  // console can render a control but cannot explain the rule behind it, so an
  // admin learns `floorDirection` by being refused (403 on a loosening write,
  // `settings-registry-write.service.ts`). Projecting them is what lets the
  // screen answer "why is this value what it is" BEFORE the click.
  @ApiPropertyOptional({ description: 'True = a kill-switch whose safe position is OFF.' })
  killSwitch?: boolean;

  @ApiPropertyOptional({
    description: '`closed` = an unset value is an outage, not a fallback; `open-to-default` = falls back to `default`.',
    example: 'closed',
  })
  failMode?: string;

  @ApiPropertyOptional({
    description: 'When set, a tenant may only move the value in this direction relative to the platform (tighten-only).',
    example: 'lower-is-stricter',
  })
  floorDirection?: string;

  @ApiPropertyOptional({
    description: 'The descriptor default. OMITTED for secret-sensitivity keys — the read surface never carries secret material.',
  })
  default?: unknown;

  @ApiPropertyOptional({
    type: [String],
    description: 'Deployables served this key on the effective-config pull route. Absent = the key travels per-request instead (tenant-scoped).',
  })
  consumedBy?: readonly string[];

  @ApiPropertyOptional({ description: 'Recorded eventual home when `tier` is not where the key ends up.', example: 'global-kv' })
  targetTier?: string;

  // TASK-969 WS-1 -- the same descriptor field the value read projects inside
  // its `pair` block, exposed here as the bare IDENTIFIER.
  //
  // It has to be on the CATALOG and not only on the value read, because the
  // console decides its row layout at LIST time and the catalog carries no
  // values by design (metadata only, so the listing is safe for any admin and
  // costs no cascade reads). Without this field nothing at list time says the
  // two keys are one thing, and the screen falls back to rendering the pair as
  // the two separate rows this ticket exists to remove.
  @ApiPropertyOptional({
    description:
      'Present iff this key is the TENANT half of a pair: the PLATFORM-tier key it pairs with. The two render as ONE row — the split into two keys is a transport decision (per-request push vs platform pull snapshot), not an audience one. Omitted for every key that stands alone.',
    example: 'text.externalGuardrail.requireMedical',
  })
  platformTierKey?: string;

  // TASK-932 R-6 / D-6 -- the LOCK, derived server-side from tier +
  // sensitivity (`settingLockFor`), never from a key list the console would have
  // to keep in step. A locked key is un-editable for EVERY caller including a
  // super administrator, and the write lane refuses it with
  // `SETTING_TIER_LOCKED`; projecting it here is what lets the screen render the
  // reason instead of an editor that would 400.
  @ApiPropertyOptional({ description: 'True = un-editable from any admin surface, for every caller including a super admin.' })
  locked?: boolean;

  @ApiPropertyOptional({
    description: 'Why the key is locked, and where its value actually changes. Present iff `locked`.',
    example: 'Bootstrap / data-plane transport value, read from the process environment and fixed for the process lifetime.',
  })
  lockReason?: string;

  @ApiPropertyOptional({
    description: 'Short badge text for the lock KIND (Bootstrap / Platform secret / Tenant secret / Secret).',
    example: 'Bootstrap',
  })
  lockLabel?: string;
}

export class SettingCatalogResponse {
  @ApiProperty({ type: [SettingCatalogItemResponse] })
  items!: SettingCatalogItemResponse[];

  @ApiProperty({ type: [String], description: 'Distinct categories present in items, sorted.' })
  categories!: string[];
}

/**
 * TASK-969 WS-1 — the PLATFORM half of a paired key, returned beside the tenant
 * half so ONE call renders ONE console row.
 *
 * Two keys exist for two CHANNELS (`text.guardrailPolicy.*` is pushed per
 * request, `text.externalGuardrail.*` rides the platform-scope pull snapshot),
 * and the registry forbids collapsing them (`consumedBy` may not appear on a
 * `maxScope: 'tenant'` descriptor). Since owner decision OD-2 both halves are
 * platform-admin-only — ONE audience — so the split has no business surfacing as
 * two rows an admin must know how to tell apart. Without this block the console
 * would have to know there are two keys and issue a second request to find out
 * what the tenant is actually inheriting.
 *
 * Present iff the descriptor declares `platformTierKey`, which is true of two of
 * the registry's keys and absent for every other.
 */
export class SettingPlatformTierPairResponse {
  @ApiProperty({
    description: 'The PLATFORM-tier key this one pairs with. Write that key at `system` scope; writing THIS key there is refused 400.',
    example: 'text.externalGuardrail.requireMedical',
  })
  platformTierKey!: string;

  @ApiProperty({
    description: 'The platform key’s effective value — what a tenant with no opinion of its own inherits.',
    example: true,
  })
  platformValue!: unknown;

  @ApiProperty({
    description: 'Backing row version of the platform key’s SYSTEM row (0 = still a code default). Echo as `If-Match` when writing THAT key.',
    example: 2,
  })
  platformVersion!: number;

  @ApiProperty({
    description:
      'Which half actually governs this tenant right now. `tenant` iff a row exists under the tenant — mirroring the runtime predicate, which pushes the override only when the cascade reports `sourceScope: "tenant"`. Anything else (a SYSTEM row on the tenant half included) is `platform`.',
    enum: ['tenant', 'platform'],
    example: 'tenant',
  })
  inForce!: 'tenant' | 'platform';
}

/**
 * Resolved effective value of one non-secret setting for a context,
 * with the winning cascade tier. Secret settings are refused (never resolved).
 */
export class EffectiveSettingResponse {
  @ApiProperty()
  key!: string;

  @ApiProperty({ example: 'db-config' })
  tier!: string;

  @ApiProperty({ description: 'The resolved effective value (type depends on the setting).' })
  value!: unknown;

  @ApiProperty({ description: 'Which cascade tier supplied the value.', example: 'department' })
  sourceScope!: string;

  /**
   * Version of the backing KV row, or 0 when the value is still a
   * code default (no row stored). Rendered as `ETag: "<version>"` by the
   * `ETagInterceptor` for positive values; echo it as `If-Match` on the PUT.
   *
   * OPTIONAL because only the key-addressed registry route (`GET
   * registry/:key`) has a single backing row to version. The generic
   * `GET effective` cascade trace spans tiers with no such row, so it omits this
   * rather than reporting a meaningless 0.
   */
  @ApiPropertyOptional({ description: 'Backing row version (0 = no stored row yet). Registry route only.', example: 3 })
  version?: number;

  /**
   * The paired PLATFORM half, for the two keys whose descriptor declares
   * `platformTierKey`. OMITTED — not null — for every other key, so a client
   * renders the pair UI on presence alone and never has to special-case a key
   * list of its own.
   */
  @ApiPropertyOptional({
    type: SettingPlatformTierPairResponse,
    description: 'Present iff this key is the TENANT half of a pair. Lets one response render both halves as a single row.',
  })
  pair?: SettingPlatformTierPairResponse;
}
