/**
 * TASK-1051 wave 0 — the FROZEN props of the dialogs lane C2 builds and lane C1's
 * screen mounts. Neither lane edits the other's files; both build against this.
 *
 * | Component (file)                                   | Owner |
 * |----------------------------------------------------|-------|
 * | `LoadPreviewDialog` (`load-preview-dialog.tsx`)     | C2    |
 * | `LinkInstanceDialog` (`link-instance-dialog.tsx`)   | C2    |
 * | `UnloadDialog` (`unload-dialog.tsx`)                | C2    |
 * | `ModelDetailDrawer` (`model-detail-drawer.tsx`)     | C2    |
 * | the screen that mounts them                        | C1    |
 */

import type { LoadModelResidencyResponse } from '@/shared/residency';
import type { LmStudioResidencyLoadOptions, ResidencyCatalogueModel, ResidencyDevice, ResidencyServiceGroup } from '../api/types';

/**
 * Artboard 04. Opens on a dry run (`useLoadPreview`), shows need / free /
 * headroom / shortfall, lets the admin tick ON_DEMAND models to unload first,
 * and loads — un-forced when it fits, forced with a mandatory reason when not.
 * Every selected eviction is unloaded (with the reason "Make room for <name>")
 * BEFORE the load is sent. TASK-1055: a GPU picker over `candidates`
 * (defaulting to `suggestedDevice`, every pick re-checked with `device`), the
 * capacity callout with "Load on <GPU>", and an optional `makeDefault`. On admission it calls `onAdmitted` with the load
 * response (202 `accepted` + `operationId`, or 200 `already_loaded`) and closes;
 * the SCREEN tracks the operation and toasts its outcome.
 */
export interface LoadPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  onAdmitted: (response: LoadModelResidencyResponse) => void;
}

/**
 * Artboard 03. For a resident row with `identity.matched === false`: pick one
 * of `identity.candidates` (strong pre-selected) and `POST links` with
 * `runtimeKey = identity.reportedKey`. "None of these" closes without a call.
 * Toasts its own success/failure; `onLinked` lets the screen close a drawer.
 */
export interface LinkInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  onLinked?: () => void;
}

/**
 * Every unload goes through this one dialog: an optional reason when idle, a
 * MANDATORY reason (and `force: true`) when `residency.inFlight > 0` or the
 * gateway answers 409 `IN_FLIGHT`. TASK-1055 (OD-2): a pinned / live-path row
 * is no longer blocked — the dialog names its consumers and the reason becomes
 * mandatory (also on a 409 `LIVE_PATH_REASON_REQUIRED`); a model held as
 * separate copies on several GPUs can be unloaded per `device`. Toasts its own outcome.
 */
export interface UnloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  onUnloaded?: () => void;
}

/** Artboard 02. Unchanged callbacks from TASK-1005, plus `onLink` for an unmatched row. */
export interface ModelDetailDrawerContractProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  devices: ResidencyDevice[];
  actionPending: boolean;
  onLoad: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onUnload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onReload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel, options: LmStudioResidencyLoadOptions) => void;
  onLink: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
}
