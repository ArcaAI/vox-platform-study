import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AiDeploymentKind } from '@arcaai/domains';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { IModelResidencyService } from '../../model-residency/IModelResidencyService';
import type { IModelResidencyService as ModelResidencyPort } from '../../model-residency/IModelResidencyService';
import { residencyServiceOf } from '../../model-residency/model-residency.types';
import { readModelDownloadSettings, type DownloadSettingsSource } from './model-download-settings';
import { deriveModelLifecycle, indexResidencyCatalogue, isUnregistering, type LifecycleRow, type ResidencyIndex } from './model-lifecycle.derive';
import type { ModelLifecycle } from './model-lifecycle.types';

type CatalogueReader = Pick<ModelResidencyPort, 'getCatalogue'>;

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

    const { staleAfterMs } = readModelDownloadSettings(this.appSettings);
    const residency = rows.some(needsResidency) ? await this.readResidency() : null;

    for (const row of rows) out.set(row.id, deriveModelLifecycle(row, residency, { now, staleAfterMs }));
    return out;
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
