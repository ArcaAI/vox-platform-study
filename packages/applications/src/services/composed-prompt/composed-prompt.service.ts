/**
 * The OD-9 composed-prompt records: the admin READ surface, the harness's internal WRITE, and the
 * retention purge.
 *
 * Reads are PHI access — the detail decrypts the exact messages a model was sent — so every read
 * is audited (`forceAuditLog`). A record of another tenant is a 404 (404-over-403).
 */
import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { ComposedPromptRecordRepository, ResourceType, SysEventType, UserRoleAssignmentRepository, type ComposedPromptRecordEntity } from '@arcaai/domains';
import { BaseService } from '../../common/base.service';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { COMPOSED_PROMPTS_DEFAULTS, COMPOSED_PROMPTS_RETENTION_DAYS_KEY } from '../settings-registry/descriptors/composed-prompts.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { ComposedPromptRecorder } from './composed-prompt.recorder';
import {
  ComposedPromptDetailResponse,
  ComposedPromptPageResponse,
  ComposedPromptSummaryResponse,
  ListComposedPromptsQuery,
  RecordComposedPromptRequest,
} from './dto/composed-prompt.dto';
import type { IComposedPromptService } from './IComposedPromptService';
import { assertPromptInspectorAccess } from './prompt-inspector-access';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const COMPOSED_PROMPT_PURGE_LOCK_KEY = 'composed-prompt-retention:lock';
const PURGE_LOCK_TTL_SECONDS = 30 * 60;

@Injectable()
export class ComposedPromptService extends BaseService implements IComposedPromptService {
  private readonly logger = new Logger(ComposedPromptService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly repository: ComposedPromptRecordRepository,
    private readonly recorder: ComposedPromptRecorder,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() private readonly settings?: TenantSettingsService,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
    @Optional() private readonly roleAssignments?: UserRoleAssignmentRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.ComposedPromptRecord);
  }

  /**
   * The harness's record of a call it made. ACCEPTED immediately and written in the background:
   * the caller is on a clinical generation path and must never wait on, or fail for, its record.
   */
  acceptInternal(dto: RecordComposedPromptRequest, tenantId: string): void {
    this.recorder.record({
      tenantId,
      consultationId: dto.consultationId ?? null,
      agentSlug: dto.agentSlug ?? null,
      phase: dto.phase,
      provider: dto.provider,
      locality: dto.locality,
      system: dto.system,
      user: dto.user,
    });
  }

  async list(query: ListComposedPromptsQuery): Promise<ComposedPromptPageResponse> {
    const tenantId = this.requireTenant();
    await this.assertMayRead(tenantId);
    const page = query.page && query.page >= 1 ? query.page : 1;
    const limit = query.limit && query.limit >= 1 ? Math.min(query.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const { data, count } = await this.repository.findPage(tenantId, { consultationId: query.consultationId }, page, limit);
    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      forceAuditLog: true,
      data: { action: 'list', consultationId: query.consultationId ?? null, count: data.length },
    });
    return { data: data.map((entity) => summaryOf(entity)), count, page, limit };
  }

  async getDecrypted(id: string): Promise<ComposedPromptDetailResponse> {
    const tenantId = this.requireTenant();
    // Privilege before existence: the gate does not vary by row, so it cannot leak one.
    await this.assertMayRead(tenantId);
    const entity = await this.repository.findById(id).catch(() => null);
    if (!entity || entity.tenantId !== tenantId) throw new NotFoundException(`Composed prompt ${id} not found`);
    if (!this.secretsService) {
      throw new NotFoundException(`Composed prompt ${id} cannot be read: no secrets provider is available to decrypt it`);
    }
    const [system, user] = await Promise.all([
      this.repository.decryptText(this.secretsService, entity.systemCiphertext),
      this.repository.decryptText(this.secretsService, entity.userCiphertext),
    ]);
    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: entity.id,
      forceAuditLog: true,
      data: { action: 'decrypt', consultationId: entity.consultationId ?? null, phase: entity.phase },
    });
    return { ...summaryOf(entity), system, user };
  }

  @Cron('15 4 * * *', { name: 'composed-prompt-retention' })
  async retention(): Promise<void> {
    await this.purgeExpired().catch((error) =>
      this.logger.error({ message: 'Composed-prompt retention purge failed', error: error instanceof Error ? error.name : 'unknown' }),
    );
  }

  /**
   * HARD-delete every record past its tenant's `composedPrompts.retentionDays`. A hard delete is
   * deliberate and sanctioned here: an expired composed prompt is a PHI audit copy whose retention
   * window has passed, and keeping a soft-deleted row would keep the PHI. One node at a time (a
   * Redis lock); every step is idempotent, so a lost lock costs only duplicated work.
   */
  async purgeExpired(): Promise<{ tenants: number; deleted: number }> {
    if (!(await this.acquireLock())) return { tenants: 0, deleted: 0 };
    try {
      const now = this.now().getTime();
      // The SHORTEST window any tenant may set is one day, so a tenant with no record older than a
      // day has nothing to purge — that bounds the work list.
      const tenantIds = await this.repository.findTenantIdsWithRecordsBefore(new Date(now - MS_PER_DAY));
      let deleted = 0;
      for (const tenantId of tenantIds) {
        const days = this.retentionDays(tenantId);
        try {
          const count = await this.repository.hardDeleteBefore(tenantId, new Date(now - days * MS_PER_DAY));
          deleted += count;
          if (count > 0) this.logger.log({ message: 'Composed-prompt records purged', tenantId, count, retentionDays: days });
        } catch (error) {
          this.logger.error({ message: 'Composed-prompt purge failed for a tenant', tenantId, error: error instanceof Error ? error.name : 'unknown' });
        }
      }
      return { tenants: tenantIds.length, deleted };
    } finally {
      await this.releaseLock();
    }
  }

  private retentionDays(tenantId: string): number {
    try {
      const value = this.settings?.resolve<number>(COMPOSED_PROMPTS_RETENTION_DAYS_KEY, tenantId).value;
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : COMPOSED_PROMPTS_DEFAULTS.retentionDays;
    } catch {
      return COMPOSED_PROMPTS_DEFAULTS.retentionDays;
    }
  }

  /** OD-9: SUPER_ADMIN or TENANT_ADMIN of this tenant (403 otherwise) — see `assertPromptInspectorAccess`. */
  private assertMayRead(tenantId: string): Promise<void> {
    return assertPromptInspectorAccess({
      user: this.requestUser,
      serviceAccount: (this.clsService as unknown as { get(key: string): unknown }).get('serviceAccount'),
      tenantId,
      roleAssignments: this.roleAssignments,
      logger: this.logger,
    });
  }

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new NotFoundException('No tenant context');
    return tenantId;
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const reply = await this.redis.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])",
        1,
        COMPOSED_PROMPT_PURGE_LOCK_KEY,
        'held',
        PURGE_LOCK_TTL_SECONDS,
      );
      return reply === 'OK';
    } catch {
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(COMPOSED_PROMPT_PURGE_LOCK_KEY).catch(() => undefined);
  }
}

function summaryOf(entity: ComposedPromptRecordEntity): ComposedPromptSummaryResponse {
  return {
    id: entity.id,
    consultationId: entity.consultationId ?? null,
    agentSlug: entity.agentSlug ?? null,
    phase: entity.phase ?? '',
    provider: entity.provider ?? '',
    locality: entity.locality ?? 'cloud',
    sha256: entity.sha256 ?? '',
    createdAt: entity.createdAt.toISOString(),
  };
}
