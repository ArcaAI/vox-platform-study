/**
 * TASK-1050 test support — the W0 domain additions, loaded from `packages/domains/src`.
 *
 * A lane worktree resolves `@arcaai/domains` to the PRIMARY checkout's built `dist`, which predates
 * W0 (the guardrail enums, entities and factories are absent there), and lanes may not rebuild a
 * package. Every TASK-1050 unit test therefore merges these source exports into the mocked
 * `@arcaai/domains` module:
 *
 *   vi.mock('@arcaai/domains', async (importOriginal) => ({
 *     ...(await importOriginal<object>()),
 *     ...(await import('<path>/support/w0-domains')),
 *   }));
 *
 * Once the merged tree is built, the dist carries the same names and this file is a no-op overlay.
 */
export { ResourceType } from '../../../../../../domains/src/enums/generated/ResourceType';
export { GuardrailDecision } from '../../../../../../domains/src/enums/generated/GuardrailDecision';
export { GuardrailDirection } from '../../../../../../domains/src/enums/generated/GuardrailDirection';
export { GuardrailItemStatus } from '../../../../../../domains/src/enums/generated/GuardrailItemStatus';
export { GuardrailNoticeStatus } from '../../../../../../domains/src/enums/generated/GuardrailNoticeStatus';
export { GuardrailNoticeType } from '../../../../../../domains/src/enums/generated/GuardrailNoticeType';
export { GuardrailNoticeFactory } from '../../../../../../domains/src/factories/generated/core/GuardrailNoticeFactory';
export { GuardrailEvaluationFactory } from '../../../../../../domains/src/factories/generated/core/GuardrailEvaluationFactory';
export { GuardrailNoticeEntity } from '../../../../../../domains/src/entities/generated/core/GuardrailNoticeEntity';
export { GuardrailEvaluationEntity } from '../../../../../../domains/src/entities/generated/core/GuardrailEvaluationEntity';
export { ContextItemFactory } from '../../../../../../domains/src/factories/generated/core/ContextItemFactory';
export { ContextItemEntity } from '../../../../../../domains/src/entities/generated/core/ContextItemEntity';
export { GuardrailNoticeEntityMapper } from '../../../../../../domains/src/mappers/generated/core/GuardrailNoticeEntityMapper';

/** Repository classes are DI tokens only in these tests; the stand-ins keep `@Inject(X)` defined. */
export class GuardrailNoticeRepository {}
export class GuardrailEvaluationRepository {}
export class GuardrailPolicyRevisionRepository {}
