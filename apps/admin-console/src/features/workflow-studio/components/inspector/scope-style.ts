/**
 * TASK-1036 §10.1 "Colour encodes scope everywhere" — one class set per scope, shared by binding
 * chips, picker groups and template tokens. Semantic tokens only; every chip also SAYS its scope
 * (visually-hidden text), so the colour is never the only signal (WCAG 1.4.1).
 */
import type { BindingScope } from '../../lib/binding-display';

export const SCOPE_CLASS: Readonly<Record<BindingScope, string>> = {
  steps: 'border-primary/40 bg-primary/10 text-foreground',
  context: 'border-success/40 bg-success/10 text-success-strong',
  consultation: 'border-ai/40 bg-ai/10 text-ai',
  run: 'border-warning/40 bg-warning/10 text-warning-strong',
  value: 'border-border bg-muted text-foreground',
  template: 'border-border bg-muted text-foreground',
};

export const SCOPE_NAME: Readonly<Record<BindingScope, string>> = {
  steps: 'Earlier step',
  context: 'Context',
  consultation: 'Consultation',
  run: 'Run & variables',
  value: 'Fixed value',
  template: 'Template',
};
