/**
 * TASK-1050 W3b — the console's guardrail result surfaces, shared by the playgrounds, the run traces and
 * consultation details (features never import each other; `shared/` is the seam).
 */
export * from './notice';
export * from './guardrail-error';
export * from './labels';
export { GuardrailBlockPanel } from './guardrail-block-panel';
export { GuardrailCheckList } from './guardrail-check-list';
export { GuardrailItemBadge } from './guardrail-item-badge';
export { GuardrailNoticeBanner } from './guardrail-notice-banner';
export { GuardrailNoticeList, type GuardrailNoticeWithState } from './guardrail-notice-list';
export { GuardrailWarningDialog } from './guardrail-warning-dialog';
