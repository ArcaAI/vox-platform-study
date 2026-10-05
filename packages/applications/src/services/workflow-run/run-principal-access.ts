import { Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ResourceStatusType, UserRoleAssignmentRepository } from '@arcaai/domains';
import { isSuperAdmin } from '../../common/tenant-guards';
import type { IActiveUserContext } from '../../interfaces/IActiveUserContext';

/**
 * TASK-1038 OD-35 (owner decision, 2026-10-05) — business-plane run reads are bound to the
 * principal that STARTED the run.
 *
 * | Reader | Reads |
 * |---|---|
 * | API key / service account | the runs that SAME credential started — or every run of the tenant when it holds the run kind's `…:run:read-all` scope |
 * | Human JWT, SUPER_ADMIN or TENANT_ADMIN of the working tenant | every run of the tenant (unchanged) |
 * | Any other human JWT (a doctor) | the runs that user started |
 *
 * It covers both run kinds (workflow runs and agent runs) and every business-plane read of one:
 * status, result, the event stream (SSE and the socket), the run stream-ticket mint, and cancel.
 * A mismatch is the house 404 with the SAME body as an unknown run — the run's existence is never
 * revealed to a principal that may not read it.
 *
 * Decisions this module encodes, so they are stated once:
 *
 * - **A machine credential never widens through its human.** An API key is a delegation of a
 *   person, but OD-35 binds the RUN to the credential: key B bound to a tenant admin still does
 *   not read key A's run. Only the read-all scope widens a machine credential.
 * - **Read-all is an EXACT grant.** `ApiKeyService.hasScope` matches parents, categories and `*`,
 *   so a key issued `workflow` or `*` would otherwise inherit it silently — the very keys OD-35
 *   is narrowing. The broader read has to be granted on purpose, as its own thing (the `workflows:`
 *   plural precedent in `apikey-scopes.registry.ts`).
 * - **No recorded starter ⇒ tenant-wide readers only.** A webhook-started run has no credential
 *   to bind to, and a row written before OD-35 carries no stamp. Failing closed means a machine
 *   caller cannot read those; a tenant admin still can.
 * - **The admin check is tenant-scoped**: SUPER_ADMIN by session roles or by an assignment in any
 *   tenant, TENANT_ADMIN only in the working tenant — `WorkflowRunTraceAccessService`'s read. An
 *   unreadable role list fails closed (the human falls back to its own runs).
 * - **A run stream ticket carries the reader it was minted under** (`runReader`). Redeeming a
 *   ticket restores only the bound human on `user`, which for an API key is not the principal the
 *   run is bound to; the ticket is single-use and scoped to one run, and it was minted only after
 *   this same check passed for that run.
 */

/** The `_metadata` key a run row records its starter under. */
export const RUN_STARTED_BY_KEY = 'startedBy';

export type RunPrincipalType = 'user' | 'apiKey' | 'serviceAccount';

/** Who started a run: the CREDENTIAL (API key id, service account id), or the human for a JWT. */
export interface RunPrincipal {
  type: RunPrincipalType;
  id: string;
}

export type RunKind = 'workflow' | 'agent';

/** The scope that lets a machine credential read every run of its kind in the tenant. */
export const RUN_READ_ALL_SCOPES: Readonly<Record<RunKind, Readonly<{ apiKey: string; serviceAccount: string }>>> = Object.freeze({
  workflow: Object.freeze({ apiKey: 'workflow:run:read-all', serviceAccount: 'svc:workflow:run:read-all' }),
  agent: Object.freeze({ apiKey: 'agent:run:read-all', serviceAccount: 'svc:agent:run:read-all' }),
});

/** What the current request may read: the runs `principal` started, or (`tenantWide`) every run. */
export interface RunReader {
  principal: RunPrincipal | null;
  tenantWide: boolean;
}

/** The API-key half of the request identity, as `UnifiedAuthGuard` publishes it on CLS `apiKey`. */
export interface RunApiKeyIdentity {
  id: string;
  scopes: string[];
}

const PRINCIPAL_TYPES: ReadonlySet<string> = new Set<RunPrincipalType>(['user', 'apiKey', 'serviceAccount']);
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const TENANT_WIDE_ROLES = ['TENANT_ADMIN'];

function asPrincipal(value: unknown): RunPrincipal | null {
  if (value === null || typeof value !== 'object') return null;
  const { type, id } = value as { type?: unknown; id?: unknown };
  if (typeof type !== 'string' || !PRINCIPAL_TYPES.has(type)) return null;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { type: type as RunPrincipalType, id };
}

/** The starter recorded on a run row's `_metadata`, or `null` (none, or malformed). */
export function readRunStartedBy(metaData: unknown): RunPrincipal | null {
  if (metaData === null || typeof metaData !== 'object' || Array.isArray(metaData)) return null;
  return asPrincipal((metaData as Record<string, unknown>)[RUN_STARTED_BY_KEY]);
}

/** `true` when `value` is a well-formed {@link RunReader} (what a stream ticket carries). */
export function isRunReader(value: unknown): value is RunReader {
  if (value === null || typeof value !== 'object') return false;
  const { principal, tenantWide } = value as { principal?: unknown; tenantWide?: unknown };
  return typeof tenantWide === 'boolean' && (principal === null || asPrincipal(principal) !== null);
}

export function sameRunPrincipal(a: RunPrincipal | null, b: RunPrincipal | null): boolean {
  return a !== null && b !== null && a.type === b.type && a.id === b.id;
}

/**
 * OD-35 — an `Idempotency-Key` names one intent OF ONE PRINCIPAL. Two credentials presenting the
 * same key must never derive the same run id (one would join — and learn the id of — the other's
 * run). A principal-less start (a webhook delivery) keeps its key unchanged.
 */
export function principalScopedIdempotencyKey(principal: RunPrincipal | null, idempotencyKey: string): string {
  return principal ? `${principal.type}:${principal.id}:${idempotencyKey}` : idempotencyKey;
}

@Injectable()
export class RunPrincipalAccessService {
  private readonly logger = new Logger(RunPrincipalAccessService.name);

  constructor(
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() private readonly roleAssignments?: UserRoleAssignmentRepository,
  ) {}

  /** The principal the current request would START a run as (and stamps on it). */
  currentPrincipal(): RunPrincipal | null {
    const ticketReader = this.ticketReader();
    if (ticketReader) return ticketReader.principal;
    const apiKey = this.apiKey();
    if (apiKey) return { type: 'apiKey', id: apiKey.id };
    const serviceAccount = this.get<{ id?: unknown }>('serviceAccount');
    if (serviceAccount && typeof serviceAccount.id === 'string' && serviceAccount.id.length > 0)
      return { type: 'serviceAccount', id: serviceAccount.id };
    const userId = this.get<{ id?: unknown }>('user')?.id;
    if (typeof userId === 'string' && userId.length > 0) return { type: 'user', id: userId };
    return null;
  }

  /** What the current request may read of `kind`'s runs. */
  async resolveReader(kind: RunKind): Promise<RunReader> {
    const ticketReader = this.ticketReader();
    if (ticketReader) return ticketReader;

    const apiKey = this.apiKey();
    if (apiKey) {
      return { principal: { type: 'apiKey', id: apiKey.id }, tenantWide: apiKey.scopes.includes(RUN_READ_ALL_SCOPES[kind].apiKey) };
    }
    const serviceAccount = this.get<{ id?: unknown; scopes?: unknown }>('serviceAccount');
    if (serviceAccount && typeof serviceAccount.id === 'string' && serviceAccount.id.length > 0) {
      const scopes = Array.isArray(serviceAccount.scopes) ? serviceAccount.scopes : [];
      return { principal: { type: 'serviceAccount', id: serviceAccount.id }, tenantWide: scopes.includes(RUN_READ_ALL_SCOPES[kind].serviceAccount) };
    }
    const user = this.get<{ id?: unknown; roles?: string[] | null }>('user');
    if (user && typeof user.id === 'string' && user.id.length > 0) {
      return { principal: { type: 'user', id: user.id }, tenantWide: await this.isTenantAdmin(user as { id: string; roles?: string[] | null }) };
    }
    return { principal: null, tenantWide: false };
  }

  /** May the current request read a run of `kind` that `startedBy` started? */
  async canRead(kind: RunKind, startedBy: RunPrincipal | null): Promise<boolean> {
    // The common case first, with no role read: the caller started this run. (A status poll or a
    // stream's periodic re-check would otherwise read the role list every time.)
    if (sameRunPrincipal(this.currentPrincipal(), startedBy)) return true;
    const reader = await this.resolveReader(kind);
    if (reader.tenantWide) return true;
    return sameRunPrincipal(reader.principal, startedBy);
  }

  private async isTenantAdmin(user: { id: string; roles?: string[] | null }): Promise<boolean> {
    if (isSuperAdmin(user)) return true;
    const tenantId = this.get<string>('tenantId');
    if (!this.roleAssignments) return false;
    try {
      const assignments = (await this.roleAssignments.findAll({
        where: { userId: user.id, resourceStatus: ResourceStatusType.ENABLED },
      })) as Array<{ tenantId?: string; Roles?: Array<{ name: string }> | null }>;
      return assignments.some((assignment) =>
        (assignment.Roles ?? []).some(
          (role) => role.name === SUPER_ADMIN_ROLE || (!!tenantId && assignment.tenantId === tenantId && TENANT_WIDE_ROLES.includes(role.name)),
        ),
      );
    } catch (error) {
      this.logger.warn({
        message: 'Could not read role assignments; run reads fall back to the caller’s own runs',
        userId: user.id,
        error: String(error),
      });
      return false;
    }
  }

  private ticketReader(): RunReader | null {
    const value = this.get<unknown>('runReader');
    if (!isRunReader(value)) return null;
    return { principal: value.principal ? asPrincipal(value.principal) : null, tenantWide: value.tenantWide };
  }

  private apiKey(): RunApiKeyIdentity | null {
    const value = this.get<{ id?: unknown; scopes?: unknown }>('apiKey');
    if (!value || typeof value.id !== 'string' || value.id.length === 0) return null;
    const scopes = Array.isArray(value.scopes) ? value.scopes.filter((s): s is string => typeof s === 'string') : [];
    return { id: value.id, scopes };
  }

  private get<T>(key: string): T | undefined {
    try {
      return (this.cls as unknown as { get: (k: string) => unknown }).get(key) as T | undefined;
    } catch {
      return undefined;
    }
  }
}
