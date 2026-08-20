import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkflowTestFixtureFactory, WorkflowTestFixtureRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SecretsService } from '../baseServices/_meta/secrets';
import { encryptPhiFields } from '../../common';
import { IWorkflowTestFixtureService } from './IWorkflowTestFixtureService';
import {
  CreateWorkflowTestFixtureRequest,
  UpdateWorkflowTestFixtureRequest,
  WorkflowTestFixtureResponse,
  PaginatedWorkflowTestFixtureResponse,
} from './dto';
import { WorkflowTestFixtureDtoMapper } from './workflow-test-fixture.dto.mapper';
import { assertEqualTenants, BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';

const WORKFLOW_TEST_FIXTURE_FILTER_MODEL = 'WorkflowTestFixture';

/**
 * Per-tenant saved synthetic Workbench test input (TASK-721 §1 item 5).
 *
 * Plain tenant-scoped CRUD — no cross-aggregate lookups. `input` is
 * Vault-Transit encrypted on write, exactly as `EvalService` treats
 * `GoldenCase.transcript`/`referenceNote` (README §6/R4, RESOLVED): the
 * plaintext column was dropped, so the ciphertext is the system of record and
 * repository decrypt-on-read repopulates the transient `input` for entitled
 * readers. "Synthetic only" remains the CONTRACT expressed in DTO copy, but it
 * is no longer the only thing standing between a pasted transcript and disk.
 */
@Injectable()
export class WorkflowTestFixtureService extends BaseService implements IWorkflowTestFixtureService {
  private readonly logger = new Logger(WorkflowTestFixtureService.name);

  constructor(
    private readonly workflowTestFixtureRepository: WorkflowTestFixtureRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so the service still constructs when Vault/SecretsService is not
    // provisioned; in that soft (non-vault) mode the encrypt step is a no-op —
    // and under SECRETS_PROVIDER=vault it FAILS CLOSED instead of persisting
    // an unencrypted payload. Mirrors `EvalService`.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowTestFixture);
  }

  /**
   * Encrypt `input` through the shared env-gated guard: a soft no-op in
   * dev/test (SECRETS_PROVIDER != vault) but fail-closed in staging/prod. The
   * guard's messages are label-only and never carry the payload.
   */
  private async encryptInput(entity: Parameters<WorkflowTestFixtureRepository['encryptFieldsIntoEntity']>[0]): Promise<void> {
    await encryptPhiFields(
      this.secretsService,
      'WorkflowTestFixture',
      () => this.workflowTestFixtureRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
      this.logger,
    );
  }

  async create(request: CreateWorkflowTestFixtureRequest): Promise<WorkflowTestFixtureResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }

    const entity = WorkflowTestFixtureFactory.CreateWorkflowTestFixture({
      tenantId,
      name: request.name,
      description: request.description ?? null,
      paletteId: request.paletteId ?? null,
      workflowDefinitionId: request.workflowDefinitionId ?? null,
      input: request.input,
      createdBy: this.requestUserId ?? undefined,
    });

    await this.encryptInput(entity);

    const saved = await this.workflowTestFixtureRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { name: saved.name },
    });

    return WorkflowTestFixtureDtoMapper.toResponse(saved);
  }

  /**
   * Tenant-scoped list. The tenant-scope Prisma extension already injects
   * `tenantId` from CLS into every read of this model (rule 02 §Client
   * Access Tiers), so `where` needs no explicit tenant predicate here.
   */
  async findAll(query: PaginatedQuery): Promise<PaginatedWorkflowTestFixtureResponse> {
    const { limit, page } = query;
    const paginatedProps = withFormattedPaginatedProps(query, WORKFLOW_TEST_FIXTURE_FILTER_MODEL);
    const countProps = withFormattedCountProps(query, WORKFLOW_TEST_FIXTURE_FILTER_MODEL);

    const fixtures = await this.workflowTestFixtureRepository.findAll(paginatedProps);
    const count = await this.workflowTestFixtureRepository.count(countProps);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { items: fixtures.map((fixture) => fixture.id) },
    });

    // PHI posture: the page projection deliberately OMITS the decrypted
    // `input` — mirrors `EvalService.listGoldenCases`, which returns
    // PHI-safe golden-case metadata only. A fixture's payload is disclosed
    // solely through the id-scoped read below, never bulk-exported by a list.
    return WorkflowTestFixtureDtoMapper.toPaginatedResponse(new FetchResponse({ data: fixtures, count, limit: limit ?? 10, page: page ?? 0 }));
  }

  /**
   * Cross-tenant access throws `NotFoundException` (404-over-403), never
   * `ForbiddenException` — rule 04. `findById` already throws
   * `DataNotFoundException` (mapped to 404 by the global filter, rule 05)
   * when no row matches; `assertEqualTenants` is defense-in-depth for the
   * case where the tenant-scope extension's read filter is bypassed (mirrors
   * `ConsentGrantService.revoke`).
   */
  async findById(id: string): Promise<WorkflowTestFixtureResponse> {
    const entity = await this.workflowTestFixtureRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });

    // The one surface that discloses the decrypted payload: id-scoped, tenant-
    // asserted, audited, and reachable only through the
    // `@CanManage('WorkflowTestFixture')` route.
    return WorkflowTestFixtureDtoMapper.toResponse(entity, { includeInput: true });
  }

  /**
   * OCC-versioned update (rule 05 §Optimistic Concurrency). Load-then-assert
   * so a cross-tenant id 404s BEFORE the CAS write fires.
   */
  async update(id: string, request: UpdateWorkflowTestFixtureRequest): Promise<WorkflowTestFixtureResponse> {
    const entity = await this.workflowTestFixtureRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const { expectedVersion, ...editableDto } = request;
    await this.updateEntity(entity, editableDto as Partial<typeof entity>);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    // Re-encrypt ONLY when the patch actually touched the payload; a
    // name/description-only PATCH must leave the persisted ciphertext alone.
    if ('input' in entity.changes) {
      await this.encryptInput(entity);
    }

    const previousVersion = entity.version;
    const updated = await this.workflowTestFixtureRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...redactPayloadChanges(entity.changes), previousVersion, newVersion: updated.version },
    });

    return WorkflowTestFixtureDtoMapper.toResponse(updated, { includeInput: true });
  }

  async deleteById(id: string): Promise<WorkflowTestFixtureResponse> {
    const entity = await this.workflowTestFixtureRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    const deleted = await this.workflowTestFixtureRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { name: deleted.name },
    });

    return WorkflowTestFixtureDtoMapper.toResponse(deleted);
  }
}

/**
 * `ResourceUpdated` carries the change set into the AuditLog queue. The payload
 * (and its ciphertext) must never land there, so both keys are replaced with a
 * marker — the audit still records THAT the payload changed, never WHAT it
 * changed to. Defense-in-depth alongside the `@Secret()` markers on the entity.
 */
function redactPayloadChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    redacted[key] = key === 'input' || key === 'encryptedInput' || key === 'keyVersion' ? '[REDACTED]' : value;
  }
  return redacted;
}
