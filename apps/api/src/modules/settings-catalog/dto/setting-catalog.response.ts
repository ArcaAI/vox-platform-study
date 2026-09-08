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
}
