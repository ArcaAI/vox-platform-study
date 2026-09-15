import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { WorkflowAssignmentServiceModule } from '../workflow-assignment/workflow-assignment.service.module';
import { ConfigResolver } from './config-resolver.service';

/**
 * ConfigResolver DI module. Imports `CoreDatabaseModule` for the `UserProfile` repository
 * (preferred-prompt threading) and the `UserSettings` repository (the doctor's DNA preference,
 * TASK-882), plus `WorkflowAssignmentServiceModule` so the `@Optional()`
 * `IWorkflowAssignmentService` resolves in production: every tenant-level decision this
 * resolver answers (auto-summary, the DNA style and redaction gates, re-visit carry-forward)
 * is read off the assigned consultation graph, and without this import the resolver would
 * silently answer its unwired defaults.
 *
 * ## TASK-972 Lane 2 — why `EffectiveSettingsModule` is NOT imported here
 *
 * `ConfigResolver.resolveEffectiveTrainingCaptureEnabled` reads the tenant's gate through
 * `EffectiveSettingsService`, so importing that module here is the obvious wiring — and it closes
 * a CYCLE, measured rather than guessed:
 *
 *   config-resolver.module → settings-registry/effective-settings.module
 *     → settings-registry/feature-availability.service → interfaces/index
 *     → interfaces/IActiveUserContext (`import { UserSession } from '../services'`)
 *     → services/index (the package-wide barrel) → config-resolver/index → config-resolver.module
 *
 * Under that cycle `ConfigResolverModule.imports[2]` evaluates to `undefined` for any load order
 * that reaches the settings registry first, and Nest refuses to create a module whose imports
 * array contains `undefined` — a boot failure, not a degraded read.
 *
 * So the settings dependency is wired by the CONSUMER instead: `GateEditMiningServiceModule`
 * declares `ConfigResolver` in its own `providers` alongside the `EffectiveSettingsModule` and
 * `CoreDatabaseModule` it already imports, which satisfies every `@Optional()` collaborator this
 * resolver has without adding an edge to the module graph. A `ConfigResolver` obtained from THIS
 * module therefore answers the training-capture gate with its code default (enabled) — correct
 * for every reader that does not enforce the gate, and the two that do use the consumer-provided
 * instance. Removing the `services` barrel from `IActiveUserContext` would make the direct import
 * safe and is the real fix; it is a package-wide change and not this ticket's.
 */
@Module({
  imports: [CoreDatabaseModule, WorkflowAssignmentServiceModule],
  providers: [ConfigResolver],
  exports: [ConfigResolver],
})
export class ConfigResolverModule {}
