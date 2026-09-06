/**
 * TASK-890 L1 — the catalogue's collaborators must actually be WIRED.
 *
 * `AiModelService` injects the provider-connection port `@Optional()` so the
 * positional unit fixtures keep their arity. That makes a missing module import
 * silent: the app boots, and every cloud- or engine-served model reports
 * `connection-resolver-unavailable` in every tenant's picker, forever. Nothing
 * else catches it — not the boot audits, not a unit test of the service, not
 * the type checker.
 *
 * Asserted by NAME rather than by identity: the class the decorator captured is
 * order-dependent under vitest's module graph (importing the connection module
 * first yields a second evaluation of it), and this test is about the module
 * DECLARING its collaborator, not about object identity.
 */
import { describe, it, expect } from 'vitest';
import { AiModelServiceModule } from '../aiModel.service.module';

describe('AiModelServiceModule', () => {
  it('declares the provider-connection module (catalogue usability) and CoreDatabaseModule (the plan-tier bound)', () => {
    const imports = (Reflect.getMetadata('imports', AiModelServiceModule) as Array<{ name?: string } | undefined>) ?? [];
    const names = imports.map((m) => m?.name);
    expect(names).toContain('AiProviderConnectionServiceModule');
    expect(names).toContain('CoreDatabaseModule');
  });

  // TASK-890 wave-1 close: same silent-optional hazard, second collaborator.
  // Without this import the catalogue resolves NO readiness provider and every
  // row reports `unknown` forever — indistinguishable from a cold snapshot.
  it('declares the readiness module (the snapshot the catalogue stamps)', () => {
    const imports = (Reflect.getMetadata('imports', AiModelServiceModule) as Array<{ name?: string } | undefined>) ?? [];
    expect(imports.map((m) => m?.name)).toContain('InferenceReadinessServiceModule');
  });
});
