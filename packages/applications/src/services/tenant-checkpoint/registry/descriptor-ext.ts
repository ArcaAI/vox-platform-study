/**
 * Restore-safety fields of a checkpoint model descriptor (TASK-1032 final fix wave). They extend
 * `CheckpointModelDescriptor` from `../contracts` by module augmentation, so the shared contract
 * file is untouched; every field is optional and read only by the export runner and the restore.
 *
 * SQL fragments here use `{a}` as the row alias placeholder; `aliased()` substitutes it.
 */
import type { CheckpointModelDescriptor } from '../contracts';

/** A single-holder slot: at most one row per `key` may occupy it (a partial or marker unique index). */
export interface CheckpointSlot {
  /** `flag` = boolean column, occupied when true and the row is not DELETED; `marker` = occupied when NOT NULL (any status). */
  kind: 'flag' | 'marker';
  column: string;
  /** Columns that, with the slot, form the unique key (a marker's own value is part of it too). */
  key: readonly string[];
}

/** Rows (or columns) only a platform administrator may write; a tenant-admin restore leaves them alone. */
export type PlatformGoverned = { kind: 'model' } | { kind: 'rows'; where: string } | { kind: 'columns'; columns: readonly string[] };

declare module '../contracts' {
  interface CheckpointModelDescriptor {
    /** Exported as NULL and never written from a checkpoint (credential hashes, verifiers, passwords). */
    redactColumns?: readonly string[];
    /** SQL value an INSERT writes for a redacted NOT NULL column (default NULL). */
    redactInsert?: Readonly<Record<string, string>>;
    /** Secrets never travel back in time: kept on update, NULL on insert (SECRET_REQUIRES_REENTRY). */
    secretColumns?: readonly string[];
    /** Skipped (PLATFORM_GOVERNED_SKIPPED) unless the restore was requested by a platform admin. */
    platformGoverned?: PlatformGoverned;
    /** Rows no restore ever touches, whoever requested it (`{a}` predicate). */
    neverTouch?: string;
    /** Single-holder slots: released first, cleared on retire, never claimed over a row the restore keeps. */
    slots?: readonly CheckpointSlot[];
    /** Extra SET clauses of a soft retire, SQL over the live row `l` (old values). */
    retireSet?: readonly string[];
    /** A staged row is never INSERTED while this holds (`{a}` = the staged row; read against live parents). */
    insertFrozenWhen?: string;
    /**
     * How a checkpoint row is handled when a non-partial unique key it needs is held by a live row the
     * restore does not remove: 'skip' = the claimant is not written (UNIQUE_SLOT_HELD) and the holder is
     * kept. Required on every soft-retire model with such a key (registry test).
     */
    uniqueSlot?: 'skip';
  }
}

export function aliased(sql: string, alias: string): string {
  return sql.replace(/\{a\}/g, alias);
}

/** Occupancy predicate of `slot` over `alias`. */
export function occupies(slot: CheckpointSlot, alias: string): string {
  return slot.kind === 'flag' ? `(${alias}."${slot.column}" AND ${alias}."resourceStatus" <> 'DELETED')` : `${alias}."${slot.column}" IS NOT NULL`;
}

/** Same slot: equal key columns (and, for a marker, the same marker value). */
export function sameSlot(slot: CheckpointSlot, a: string, b: string): string {
  const cols = slot.kind === 'marker' ? [...slot.key, slot.column] : [...slot.key];
  return cols.map((c) => `${a}."${c}" = ${b}."${c}"`).join(' AND ');
}

export type { CheckpointModelDescriptor };
