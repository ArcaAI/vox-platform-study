import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ITenantReferenceSetService } from './ITenantReferenceSetService';
import { TenantReferenceSetService } from './tenant-reference-set.service';

/**
 * TASK-890 §3.4 — the reference-set provisioning module.
 *
 * A LEAF module on purpose. It calls four kind-owning services (agents, prompts, workflows,
 * context schemas) but imports NONE of their modules, because doing so closes a module cycle
 * that already exists — EntitlementsServiceModule → TenantServiceModule → here →
 * AgentServiceModule → AiProviderConnectionServiceModule → EntitlementsServiceModule. Measured
 * on this branch, that cycle does not merely warn: with the edge present the gateway never
 * finishes `NestFactory.create` (first as an `UndefinedModuleException`, and once `forwardRef`
 * deferred the reference, as a silent hang at 0% CPU). Neither failure mode is acceptable for a
 * provisioning step that runs inside tenant creation.
 *
 * So the four collaborators are resolved from the CONTAINER at call time
 * (`ModuleRef.get(token, { strict: false })`) rather than through the module graph: every one of
 * them is already registered by the app that hosts this service, and an absent one is reported
 * as a named warning on the run summary instead of a boot failure. See the service's own
 * doc comment for what each port is used for.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [TenantReferenceSetService, { provide: ITenantReferenceSetService, useExisting: TenantReferenceSetService }],
  exports: [ITenantReferenceSetService, TenantReferenceSetService],
})
export class TenantReferenceSetServiceModule {}
