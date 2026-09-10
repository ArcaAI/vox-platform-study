/**
 * TASK-947 R2 L-5 — the bench ack's `composition.excluded[].detail` is the evaluator's own message
 * for a `condition_error`, and three of those messages embed an OPERAND: `no such key: '<index>'`
 * (a dynamic index is a scope value), `int() cannot parse <value>` and `double() cannot parse
 * <value>`. The bench renders only the caller's own tenant and context, so nothing crosses a
 * boundary — but the field reaches a browser and its logs, and the value adds nothing an author
 * needs: what tells them to write `has(…)` or to read the ROOT is the SHAPE of the problem.
 *
 * Pure. Applied at the ONE place `detail` leaves the process (the bench ack); the runtime lanes
 * never carry it (OD-11).
 */
export function redactConditionDetail(detail: string): string {
  return detail
    .replace(/cannot parse .*$/, 'cannot parse <value>')
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"');
}
