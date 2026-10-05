import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ConfigResolverModule } from '../config-resolver/config-resolver.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { CONSULTATION_READ_MODEL_ASSEMBLER, ConsultationReadService } from './consultation-read.service';
import { ConsultationReadModelAssembler } from './consultation-read-model.assembler';
import { IConsultationReadService } from './IConsultationReadService';

/**
 * TASK-1036 §9.3 / TASK-1038 — the `consultation.*` declared-read plane.
 *
 * - CommonServiceModule → events, CLS, `SecretsService` (PHI decrypt).
 * - CoreDatabaseModule → run, definition, consultation, context-item, segment, media, department
 *   and DNA-report repositories.
 * - ConfigResolverModule → the doctor's DNA opt-out; EffectiveSettingsModule → the tenant's
 *   output-language policy. Neither imports anything that reaches back here.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigResolverModule, EffectiveSettingsModule],
  providers: [
    ConsultationReadModelAssembler,
    { provide: CONSULTATION_READ_MODEL_ASSEMBLER, useExisting: ConsultationReadModelAssembler },
    ConsultationReadService,
    { provide: IConsultationReadService, useExisting: ConsultationReadService },
  ],
  exports: [IConsultationReadService, ConsultationReadService],
})
export class ConsultationReadServiceModule {}
