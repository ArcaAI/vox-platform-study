import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { RedisCacheModule } from '../baseServices/redis';
import { ConsultationServiceModule } from '../consultation/consultation/consultation.service.module';
import { HarnessGatewayServiceModule } from '../consultation/harness/harness-gateway.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { WorkflowRunServiceModule } from '../workflow-run';
import { IWorkflowExposureService } from './IWorkflowExposureService';
import { WorkflowExposureService } from './workflow-exposure.service';

/**
 * WorkflowExposureService DI module.
 *
 * - CommonServiceModule -> config (`WORKFLOW_EXPOSURE_*`) + `IS3Service` (claim-check
 *   blob write).
 * - CoreDatabaseModule -> `WorkflowDefinitionRepository`.
 * - RedisCacheModule -> `IRedisCacheService` (Idempotency-Key replay cache). `@Global()`
 *   once registered, but imported explicitly here so this module is self-contained if loaded in
 *   isolation (a unit-test Nest context, for example).
 * - HarnessGatewayServiceModule -> the outbound harness dispatcher client (leaf module, matches
 *   every other consumer: `note-generation`, `live-documentation`, `summary`, `knowledge`, `eval`).
 * - WorkflowRunServiceModule -> `IWorkflowRunService` (the read-model / ownership-anchor writes).
 * - EntitlementsServiceModule -> `IEntitlementsService` (`monthlyWorkflowInvocations` meter check).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    RedisCacheModule.register(),
    HarnessGatewayServiceModule,
    WorkflowRunServiceModule,
    EntitlementsServiceModule,
    // lane A -> `IConsultationService`, used ONLY to re-resolve the PATH
    // `consultationId` against the caller's tenant before it may become a run's `subject`. No
    // cycle: ConsultationServiceModule imports neither this module nor anything leading back to
    // it (its own module doc records the same check for ConsentServiceModule).
    ConsultationServiceModule,
  ],
  providers: [
    WorkflowExposureService,
    {
      provide: IWorkflowExposureService,
      // useExisting, not useClass — useClass would construct a second
      // WorkflowExposureService instance instead of aliasing the one above.
      useExisting: WorkflowExposureService,
    },
  ],
  exports: [IWorkflowExposureService, WorkflowExposureService],
})
export class WorkflowExposureServiceModule {}
