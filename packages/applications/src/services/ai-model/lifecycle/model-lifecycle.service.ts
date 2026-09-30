import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AiDeploymentKind } from '@arcaai/domains';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { IModelResidencyService } from '../../model-residency/IModelResidencyService';
import type { IModelResidencyService as ModelResidencyPort } from '../../model-residency/IModelResidencyService';
import { residencyServiceOf } from '../../model-residency/model-residency.types';
import type { ModelResidencyService, ModelResidencyStateSnapshot } from '../../model-residency/model-residency.service';
import { effectiveStaleAfterMs, readModelDownloadSettings, type DownloadSettingsSource } from './model-download-settings';
import { deriveModelLifecycle, indexResidencyCatalogue, isUnregistering, type LifecycleRow, type ResidencyIndex } from './model-lifecycle.derive';
import type { ModelLifecycle, ModelLifecycleStatus, ModelServiceState, ModelServiceStatus } from './model-lifecycle.types';

// `getLifecycleStates` is optional on the port: the IModelResidencyService token
// is provided by ModelResidencyService, which carries it; a double that lacks it
// simply yields registry-only statuses.
type CatalogueReader = Pick<ModelResidencyPort, 'getCatalogue'> & Partial<Pick<ModelResidencyService, 'getLifecycleStates'>>;

/**
 * The `/ai-models` grid's one-word status per row (TASK-1019 D-9), joined from
 * the registry row (download / unregister bookkeeping, measured availability)
 * and the residency catalogue (what each observed service holds right now).
 *
 * ONE catalogue read per call, whatever the row count. The catalogue is
 * platform administration (tenant-less super admin only) and depends on four
 * live services reporting, so a failure to read it NEVER fails the list: the
 * rows fall back to the registry facts alone, with `observedAt: null`.
 */
@Injectable()
export class ModelLifecycleService {
  private readonly logger = new Logger(ModelLifecycleService.name);

  constructor(
    @Optional() @Inject(IModelResidencyService) private readonly residency?: CatalogueReader,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: DownloadSettingsSource,
  ) {}

  async forRows(rows: LifecycleRow[], now = Date.now()): Promise<Map<string, ModelLifecycle>> {
    const out = new Map<string, ModelLifecycle>();
    if (rows.length === 0) return out;

    const staleAfterMs = effectiveStaleAfterMs(readModelDownloadSettings(this.appSettings));
    const residency = rows.some(needsResidency) ? await this.readResidency() : null;

    for (const row of rows) out.set(row.id, deriveModelLifecycle(row, residency, { now, staleAfterMs }));
    return out;
  }

  /**
   * The one-word status per row for callers who may NOT read the residency
   * catalogue (the tenant-visible registry view). Same derivation as
   * {@link forRows}, but the residency evidence comes from the UNGATED
   * status-only read (identity + state), and only the status leaves this method.
   */
  async statusForRows(rows: LifecycleRow[], now = Date.now()): Promise<Map<string, ModelLifecycleStatus>> {
    const out = new Map<string, ModelLifecycleStatus>();
    if (rows.length === 0) return out;

    const staleAfterMs = effectiveStaleAfterMs(readModelDownloadSettings(this.appSettings));
    const residency = rows.some(needsResidency) ? await this.readResidencyStates() : null;

    for (const row of rows) out.set(row.id, deriveModelLifecycle(row, residency, { now, staleAfterMs }).status);
    return out;
  }

  private async readResidencyStates(): Promise<ResidencyIndex | null> {
    if (!this.residency?.getLifecycleStates) return null;
    try {
      return indexResidencyStates(await this.residency.getLifecycleStates());
    } catch (error) {
      this.logger.warn({
        message: 'ai_model.lifecycle.residency_states_unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async readResidency(): Promise<ResidencyIndex | null> {
    if (!this.residency) return null;
    try {
      return indexResidencyCatalogue(await this.residency.getCatalogue());
    } catch (error) {
      this.logger.warn({
        message: 'ai_model.lifecycle.residency_unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

/** Only a self-hosted row the residency ledger observes can change status on its evidence. */
function needsResidency(row: LifecycleRow): boolean {
  if (row.deploymentKind !== AiDeploymentKind.SELF_HOSTED || isUnregistering(row.metaData)) return false;
  return residencyServiceOf({ servedBy: row.servedBy ?? '', provider: row.provider ?? null }) !== null;
}

const SERVICE_STATES: ReadonlySet<string> = new Set<ModelServiceState>(['loaded', 'loading', 'unloading', 'not_loaded', 'failed']);

/** Index the status-only snapshot the way `indexResidencyCatalogue` indexes the full catalogue — state only, no placement. */
function indexResidencyStates(snapshot: ModelResidencyStateSnapshot): ResidencyIndex {
  const byId = new Map<string, ModelServiceStatus[]>();
  const bySlug = new Map<string, ModelServiceStatus[]>();
  for (const group of snapshot.services ?? []) {
    for (const model of group.models ?? []) {
      const status: ModelServiceStatus = {
        service: group.service,
        state: (SERVICE_STATES.has(model.state) ? model.state : 'not_loaded') as ModelServiceState,
        device: null,
        bytes: null,
        inFlight: null,
        requestsPerMin: null,
        error: null,
      };
      if (model.aiModelId) byId.set(model.aiModelId, [...(byId.get(model.aiModelId) ?? []), status]);
      else if (model.slug) bySlug.set(model.slug, [...(bySlug.get(model.slug) ?? []), status]);
    }
  }
  return { observedAt: snapshot.reportedAt ?? null, byId, bySlug };
}
