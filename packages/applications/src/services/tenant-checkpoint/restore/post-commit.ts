/**
 * Post-commit steps of a restore. The tenant's data is already committed; each step here makes a
 * cache, a session store or a derived index agree with it. A failing step never undoes the
 * restore — it becomes a warning, and the restore ends COMPLETED_WITH_WARNINGS.
 *
 * Steps (each guarded on its own):
 *   - settings: `refreshCache()` + a `ResourceUpdated(GlobalSetting)` sys-event, whose handler
 *     publishes the cross-instance invalidation every node (and the origin registry) listens to;
 *     plus the rate-limit rule invalidation channel.
 *   - sessions: per-user not-before for every member whose assignments changed; the Redis ability
 *     cache of the tenant is dropped.
 *   - service accounts: the live exchanged tokens of every retired account are purged.
 *   - knowledge: retired documents lose their vectors; restored/changed documents have their live
 *     chunks retired and vectors deleted, then are re-ingested from the checkpoint's chunk text.
 *   - workflow runs: a RUNNING run governing a consultation the restore retired is CANCELED.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { generateId, JobQueue, ResourceType, SysEventType } from '@arcaai/domains';

import { PolicyEngine } from '../../../authorization/policy.engine';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import { IJwtRevocationService } from '../../auth/jwt-revocation.service';
import type { IngestKnowledgeDocumentJobPayload } from '../../knowledge/ingest-knowledge-document.processor';
import { KnowledgeVectorCleanupClient } from '../../knowledge/knowledge-vector-cleanup.client';
import { RATE_LIMIT_RULES_INVALIDATION_CHANNEL } from '../../rate-limit/rate-limit-rule.constants';
import type { RestorableCategory, RestoreWarning, SqlQuery } from '../contracts';
import type { ReconcileResult } from './reconciler';

/** Same key space `ServiceAccountService` writes exchanged tokens under. */
export const SERVICE_ACCOUNT_TOKEN_PREFIX = 'svcacct:token:';
const PHI_TRANSIT_KEY = 'hope-phi';

export interface PostCommitContext {
  tenantId: string;
  restoreId: string;
  actorId: string;
  categories: readonly RestorableCategory[];
  result: ReconcileResult;
  query: SqlQuery;
}

@Injectable()
export class CheckpointRestorePostCommit {
  private readonly logger = new Logger(CheckpointRestorePostCommit.name);

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: Pick<IAppSettingsService, 'refreshCache'>,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IJwtRevocationService) private readonly jwtRevocation: Pick<IJwtRevocationService, 'revokeAllForUser'>,
    @Inject(IRedisCacheService) private readonly redis: Pick<IRedisCacheService, 'keys' | 'get' | 'delMany' | 'publish'>,
    @InjectQueue(JobQueue.IngestKnowledgeDocument) private readonly ingestQueue: Pick<Queue, 'add'>,
    private readonly vectors: KnowledgeVectorCleanupClient,
    @Optional() @Inject(SecretsService) private readonly secrets?: Pick<SecretsService, 'decryptBatch'>,
    @Optional() private readonly policyEngine?: PolicyEngine,
  ) {}

  async run(ctx: PostCommitContext): Promise<RestoreWarning[]> {
    const warnings: RestoreWarning[] = [];
    const step = async (code: string, message: string, work: () => Promise<Record<string, unknown> | void>) => {
      try {
        const detail = await work();
        if (detail) warnings.push({ code, message, detail });
      } catch (error) {
        this.logger.warn({ message: 'Restore post-commit step failed', restoreId: ctx.restoreId, code, error: errorName(error) });
        warnings.push({ code, message, detail: { error: errorName(error) } });
      }
    };

    if (ctx.categories.includes('CONFIG_CONTENT')) {
      await step('SETTINGS_REFRESH_FAILED', 'Settings caches could not be refreshed; nodes converge on their next refresh', async () => {
        await this.appSettings.refreshCache();
        this.eventEmitter.emit(SysEventType.ResourceUpdated, {
          id: generateId(),
          type: SysEventType.ResourceUpdated,
          resourceType: ResourceType.GlobalSetting,
          resourceId: ctx.restoreId,
          tenantId: ctx.tenantId,
          responsibleEntityId: ctx.actorId,
          data: { action: 'tenant-restore', restoreId: ctx.restoreId },
        });
        await this.redis.publish(RATE_LIMIT_RULES_INVALIDATION_CHANNEL, JSON.stringify({ source: 'tenant-restore', tenantId: ctx.tenantId }));
      });
    }

    if (ctx.result.touchedUserIds.length) {
      const failed: string[] = [];
      for (const userId of ctx.result.touchedUserIds) {
        await this.jwtRevocation.revokeAllForUser(userId).catch(() => failed.push(userId));
      }
      if (failed.length) warnings.push({ code: 'USER_SESSION_REVOKE_FAILED', message: 'Sessions of some members could not be revoked', detail: { userIds: failed } });
    }
    if (ctx.categories.includes('USERS_ACCESS') && this.policyEngine) {
      await step('ABILITY_CACHE_INVALIDATION_FAILED', 'Cached permissions of the tenant could not be dropped; they expire within 5 minutes', async () => {
        await this.policyEngine!.invalidateTenant(ctx.tenantId);
      });
    }

    if (ctx.result.retiredServiceAccountIds.length) {
      await step('SERVICE_ACCOUNT_TOKEN_PURGE_FAILED', 'Live tokens of retired service accounts could not be purged; they expire on their own TTL', async () => {
        await this.purgeServiceAccountTokens(new Set(ctx.result.retiredServiceAccountIds));
      });
    }

    const { reingest, retired } = ctx.result.knowledge;
    if (reingest.length || retired.length) {
      await step('KNOWLEDGE_REINDEX_FAILED', 'Knowledge documents could not be fully re-indexed', async () => this.reindexKnowledge(ctx));
    }

    if (ctx.result.retiredConsultationIds.length) {
      await step('WORKFLOW_RUN_CANCEL_FAILED', 'Runs of retired consultations could not be marked canceled', async () => {
        await ctx.query(
          `UPDATE core."WorkflowRun" w
              SET "status" = 'CANCELED', "endedAt" = COALESCE(w."endedAt", now()), "updatedAt" = now(), "_version" = w."_version" + 1,
                  "_metadata" = COALESCE(w."_metadata", '{}'::jsonb) || jsonb_build_object('canceledBy', $3::text)
            WHERE w."tenantId" = $1 AND w."status" = 'RUNNING'
              AND w."runId" IN (SELECT c."_metadata"->'governingEngine'->>'workflowRunId' FROM core."Consultation" c
                                 WHERE c."tenantId" = $1 AND c."id" = ANY($2))`,
          [ctx.tenantId, ctx.result.retiredConsultationIds, `tenant-restore:${ctx.restoreId}`],
        );
      });
    }

    return warnings;
  }

  /** Mirrors `ServiceAccountService.revoke`'s purge: delete every exchanged token of the given accounts. */
  private async purgeServiceAccountTokens(accountIds: ReadonlySet<string>): Promise<void> {
    const keys = await this.redis.keys(`${SERVICE_ACCOUNT_TOKEN_PREFIX}*`);
    const doomed: string[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      try {
        if (accountIds.has((JSON.parse(raw) as { serviceAccountId?: string }).serviceAccountId ?? '')) doomed.push(key);
      } catch {
        /* a malformed entry is not ours; its TTL clears it */
      }
    }
    if (doomed.length) await this.redis.delMany(doomed);
  }

  private async reindexKnowledge(ctx: PostCommitContext): Promise<Record<string, unknown> | void> {
    const { reingest, retired, chunks } = ctx.result.knowledge;
    const failed: string[] = [];
    const stale = [...new Set([...retired, ...reingest])];

    // The ingest job appends chunks; it never replaces them. Retire the live chunks first.
    await ctx.query(
      `UPDATE core."KnowledgeChunk" SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now(), "resourceStatusUpdatedBy" = $3,
              "updatedAt" = now(), "_version" = "_version" + 1
        WHERE "tenantId" = $1 AND "knowledgeDocumentId" = ANY($2) AND "resourceStatus" <> 'DELETED'`,
      [ctx.tenantId, stale, ctx.actorId],
    );
    for (const id of stale) {
      await this.vectors.deleteByDocument({ tenantId: ctx.tenantId, knowledgeDocumentId: id }).catch(() => failed.push(id));
    }

    for (const id of reingest) {
      if (failed.includes(id)) continue;
      const parts = [...(chunks[id] ?? [])].sort((a, b) => a.chunkIndex - b.chunkIndex);
      if (!parts.length) continue; // nothing was indexed at checkpoint time
      try {
        if (!this.secrets) throw new Error('no secrets provider for the PHI transit key');
        if (parts.some((p) => !p.encryptedText)) throw new Error('a checkpoint chunk carries no ciphertext');
        const plain = await this.secrets.decryptBatch(
          parts.map((p) => p.encryptedText as string),
          PHI_TRANSIT_KEY,
        );
        const payload: IngestKnowledgeDocumentJobPayload = {
          jobId: generateId(),
          knowledgeDocumentId: id,
          tenantId: ctx.tenantId,
          userId: ctx.actorId,
          text: plain.map((b) => b.toString('utf8')).join('\n\n'),
        };
        await this.ingestQueue.add(JobQueue.IngestKnowledgeDocument, payload, { jobId: payload.jobId, attempts: 3 });
      } catch {
        failed.push(id);
      }
    }
    if (failed.length) return { documentIds: failed };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'Error';
}
