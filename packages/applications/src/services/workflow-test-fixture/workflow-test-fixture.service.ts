import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkflowTestFixtureFactory, WorkflowTestFixtureRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
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
 * Plain tenant-scoped CRUD — no cross-aggregate lookups. `input` is a
 * SYNTHETIC-ONLY contract enforced by DTO copy, not by this service; no
 * redaction/encryption happens here (see the ticket README §6/R4 —
 * HUMAN-GATED, not resolved in this ticket).
 */
@Injectable()
export class WorkflowTestFixtureService extends BaseService implements IWorkflowTestFixtureService {
  constructor(
    private readonly workflowTestFixtureRepository: WorkflowTestFixtureRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowTestFixture);
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

    return WorkflowTestFixtureDtoMapper.toResponse(entity);
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

    const previousVersion = entity.version;
    const updated = await this.workflowTestFixtureRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    return WorkflowTestFixtureDtoMapper.toResponse(updated);
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
