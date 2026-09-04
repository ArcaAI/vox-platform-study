/**
 * @arcaai/vox/plugins/med-ner
 *
 * Dedicated entry point for the optional Medical NER plugin hook.
 *
 * This is a separate entry point because `@arcaai/med-ner` is an optional
 * peer dependency (~300MB models). Importing from `@arcaai/vox/plugins` will
 * NOT pull in this dependency — consumers must explicitly opt in by importing
 * from this path.
 *
 * @example
 * ```tsx
 * import { useMedNER } from '@arcaai/vox/plugins/med-ner';
 *
 * function NERPanel() {
 *   const { entities, extract, isLoading } = useMedNER({ autoExtract: true });
 *   return <div>{entities.map(e => <span key={e.text}>{e.text}</span>)}</div>;
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * @deprecated TASK-865 — removed in R4 together with this entry point and `@arcaai/med-ner`.
 * Entity extraction runs in `apps/nlp` through the realtime lane (`agent.ner`); the browser
 * never runs a model.
 */
export { useMedNER } from '@arcaai/med-ner';
