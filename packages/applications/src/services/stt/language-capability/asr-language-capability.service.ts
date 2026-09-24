import { createHash } from 'node:crypto';
import { HttpException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AsrAgentResolverService } from '../agent-resolver/asr-agent-resolver.service';
import { StreamingSessionService } from '../streaming/streamingSession.service';
import type { LanguageCapabilityLevel, SttLanguageModeCatalog } from '../streaming/dto';

/**
 * TASK-1004 — how long one tenant's per-agent catalog is reused in THIS process.
 *
 * The catalog is STT's static capability matrix judged against an agent's engine chain, so it
 * changes only when the tenant re-points or republishes its ASR agent; a short TTL bounds that
 * staleness without an invalidation channel, and the strong ETag makes every revalidation free.
 * An implementation detail of the read path, not a tunable (the answer it caches is exact).
 */
const CATALOG_CACHE_TTL_MS = 30_000;

/** A mode the tenant can pick whose primary engine serves it only partially, or not at all. */
export interface LanguageCapabilityWarning {
  code: 'LANGUAGE_MODE_DEGRADED' | 'LANGUAGE_MODE_UNSUPPORTED';
  agentSlug: string;
  mode: string;
  /** The PRIMARY engine (`AiModelFormat`) the warning is about. */
  engine: string;
  level: Exclude<LanguageCapabilityLevel, 'native'>;
  message: string;
}

export interface LanguageModeCatalogView {
  catalog: SttLanguageModeCatalog;
  /** Strong validator over the exact representation. */
  etag: string;
}

/**
 * TASK-1004 §4.4 / §4.5 — the language capability of a tenant's ASR agent.
 *
 *  - {@link catalogFor}: the language-mode catalog judged against the agent's ENGINE CHAIN
 *    (`levels` per engine, `effective` for the chain), with a strong ETag and a short in-process
 *    cache keyed by `(tenantId, agentSlug)` — the tenant is part of the key (rule 09, M4) because
 *    the default agent, and so the answer, is per tenant.
 *  - {@link warningsForAgent}: the configuration-time guard — one warning per catalog mode the
 *    agent's PRIMARY engine degrades or cannot serve. Advisory only: it never blocks an admin
 *    write and never re-routes anything (language never selects the engine, TASK-1003 OD-6).
 */
@Injectable()
export class AsrLanguageCapabilityService {
  private readonly logger = new Logger(AsrLanguageCapabilityService.name);
  private readonly cache = new Map<string, { expiresAt: number; view: LanguageModeCatalogView }>();

  constructor(
    private readonly sessions: StreamingSessionService,
    // Optional: a gateway without ASR agent resolution still serves the catalog-wide payload.
    @Optional() private readonly asrResolver?: AsrAgentResolverService,
  ) {}

  async catalogFor(tenantId: string, agentSlug: string | null): Promise<LanguageModeCatalogView> {
    const key = `${tenantId}::${agentSlug ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.view;

    const chain = await this.chainOf(tenantId, agentSlug);
    let catalog: SttLanguageModeCatalog | null = null;
    if (chain && chain.formats.length > 0) {
      try {
        const judged = await this.sessions.fetchLanguageModes(chain.formats);
        catalog = { modes: judged.modes, agentSlug: chain.agentSlug, engines: chain.formats };
      } catch (error) {
        // e.g. STT 422 for a format it does not execute: say so, and answer what it CAN say.
        this.logger.warn({
          message: 'Language-mode catalog could not be judged against the agent chain; serving the catalog-wide payload',
          tenantId,
          agentSlug: chain.agentSlug,
          engines: chain.formats,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    catalog ??= await this.sessions.getLanguageModes();

    const view = { catalog, etag: strongEtag(catalog) };
    // An empty catalog means STT was unreachable; never pin that for the TTL.
    if (catalog.modes.length > 0) this.cache.set(key, { expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, view });
    return view;
  }

  /** Never throws: a warning that cannot be computed is no warning, and an admin write goes ahead. */
  async warningsForAgent(tenantId: string, agentSlug: string): Promise<LanguageCapabilityWarning[]> {
    try {
      const { catalog } = await this.catalogFor(tenantId, agentSlug);
      const primary = catalog.engines?.[0];
      if (!primary || !catalog.agentSlug) return [];
      const warnings: LanguageCapabilityWarning[] = [];
      for (const mode of catalog.modes) {
        const level = mode.levels?.[primary];
        if (mode.id === 'auto' || !level || level === 'native') continue;
        warnings.push({
          code: level === 'degraded' ? 'LANGUAGE_MODE_DEGRADED' : 'LANGUAGE_MODE_UNSUPPORTED',
          agentSlug: catalog.agentSlug,
          mode: mode.id,
          engine: primary,
          level,
          message:
            level === 'degraded'
              ? `ASR agent '${catalog.agentSlug}' serves '${mode.id}' on ${primary} only partially; sessions still run and their receipt reports it as degraded.`
              : `ASR agent '${catalog.agentSlug}' cannot serve '${mode.id}' on its primary engine ${primary}; ${
                  mode.effective && mode.effective !== 'unsupported'
                    ? 'its fallback engine will serve it'
                    : 'a session asking for it is refused (422)'
                }.`,
        });
      }
      return warnings;
    } catch (error) {
      this.logger.warn({
        message: 'Language capability warnings could not be computed; the write proceeds without them',
        tenantId,
        agentSlug,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * The chain to judge, or `null` for "judge nothing — serve the catalog-wide payload". An
   * explicit slug that does not resolve is the resolver's own answer (404 etc.); with no slug, a
   * tenant that has no ASR agent assigned simply gets the catalog-wide payload, as before.
   */
  private async chainOf(tenantId: string, agentSlug: string | null): Promise<{ agentSlug: string; formats: string[] } | null> {
    if (!this.asrResolver) {
      if (agentSlug) throw new ServiceUnavailableException('ASR agent resolution is not configured on this gateway');
      return null;
    }
    try {
      return await this.asrResolver.resolveChainFormats({ tenantId, agentSlug });
    } catch (error) {
      if (agentSlug || !(error instanceof HttpException)) throw error;
      return null;
    }
  }
}

function strongEtag(catalog: SttLanguageModeCatalog): string {
  return `"${createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 32)}"`;
}
