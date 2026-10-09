import { ActionConfirmationService } from '@arcaai/applications';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, ForbidApiKey, NoOptimisticConcurrency, RequiredSvcScopes } from '../../decorators';
import {
  ActionConfirmationPlatformRowsResponse,
  ActionConfirmationWriteBatchRequest,
  ActionConfirmationWriteResponse,
  EffectiveActionConfirmationsResponse,
} from './dto/action-confirmations.dto';

/**
 * Action confirmations (TASK-1057) — the platform policy that decides whether an admin action
 * demands a reason / evidence / acknowledgement.
 *
 *  - `GET action-confirmations/effective` — values every admin's dialogs need.
 *  - `GET/PUT action-confirmations` — the platform admin's screen. Super administrators only,
 *    imperatively (see the AUTH-NOTEs).
 *
 * Mounted at `admin/settings` inside `SettingsCatalogModule`, registered BEFORE
 * `GlobalSettingModule`, so the static segments win over `admin/settings/:id`.
 */
@ApiTags('admin-settings-features')
@ApiBearerAuth()
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:settings:manage')
@Controller('admin/settings')
export class SettingsActionConfirmationsController {
  constructor(private readonly confirmations: ActionConfirmationService) {}

  /**
   * AUTH-NOTE: deliberately NOT gated to super administrators. This serves VALUES only — the
   * platform-tier policy every admin's confirmation dialogs need to render the right fields. The
   * switch is platform-only (SYSTEM) so the answer is identical for every caller; there is no
   * write path and nothing tenant-specific to leak.
   */
  @Get('action-confirmations/effective')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'Resolve the confirmation requirement of every confirmable admin action.',
    description:
      'Values only, identical for every caller (the switch is platform-only, SYSTEM tier). Locked rows (impersonation, break-glass, step-up, billing reason code) always report `required`.',
  })
  @ApiResponse({ status: 200, type: EffectiveActionConfirmationsResponse })
  @ApiResponse({ status: 403, description: 'The caller lacks `read:GlobalSetting`.' })
  getEffective(): EffectiveActionConfirmationsResponse {
    return { items: this.confirmations.effective() };
  }

  /**
   * AUTH-NOTE: SUPER_ADMIN-only, enforced imperatively in
   * `ActionConfirmationService.assertPlatformAccess` (403). The class-level `@CanRead('GlobalSetting')`
   * cannot express it: a tenant admin legitimately holds `read:GlobalSetting` for its OWN rows and
   * there is no super-admin CASL subject. Row-independent, so it runs first.
   */
  @Get('action-confirmations')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'The platform action-confirmation policy: every catalogue row with its mode and version.',
    description:
      'SUPER_ADMIN only (403 otherwise). Each row carries the catalogue spec, the effective `mode`, its `source` (`system` row, code `default`, or `locked`) and the FRESH row `version` to echo as `expectedVersion`.',
  })
  @ApiResponse({ status: 200, type: ActionConfirmationPlatformRowsResponse })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  async getPlatform(): Promise<ActionConfirmationPlatformRowsResponse> {
    return { items: await this.confirmations.readPlatform() };
  }

  /**
   * AUTH-NOTE: SUPER_ADMIN-only, same imperative gate and reasoning as `getPlatform` (403). Each
   * cell is written through `SettingsRegistryWriteService`, so descriptor guards, the sys-event
   * and cache invalidation happen as for a single-key PUT.
   */
  @Put('action-confirmations')
  @CanManage('GlobalSetting')
  @NoOptimisticConcurrency(
    'per-CELL preconditions: each action is a separate SYSTEM row and carries its own `expectedVersion`, so one `If-Match` header could not address the batch',
  )
  @ApiOperation({
    summary: 'Apply a batch of action-confirmation mode edits.',
    description:
      'SUPER_ADMIN only (403 otherwise). `mode: null` resets the row to the catalogue default. The batch is ORDERED and PARTIAL and answers 200 either way: unknown or locked actions and modes the row does not allow come back in `errors[]` with status 400, version drift with 412.',
  })
  @ApiResponse({ status: 200, type: ActionConfirmationWriteResponse })
  @ApiResponse({ status: 400, description: 'Malformed batch (empty, over the 200-cell cap, or an invalid mode).' })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  async putPlatform(@Body() request: ActionConfirmationWriteBatchRequest): Promise<ActionConfirmationWriteResponse> {
    return this.confirmations.applyPlatform(
      request.cells.map((cell) => ({
        actionId: cell.actionId,
        mode: cell.mode ?? null,
        ...(cell.expectedVersion === undefined ? {} : { expectedVersion: cell.expectedVersion }),
      })),
    );
  }
}
