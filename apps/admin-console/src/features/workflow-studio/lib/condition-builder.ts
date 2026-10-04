/**
 * TASK-1036 §8.4 item 6 — "Conditions without CEL". A visual rule builder (field from the picker,
 * operator, value) GENERATES the CEL a `core.condition` branch stores in `when`; raw CEL stays
 * available behind "Edit as expression". The reverse parse is deliberately narrow: an expression
 * the builder could not have written returns `null`, and the field then opens in expression mode
 * rather than silently rewriting what the author typed.
 *
 * Paths: CEL's roots are `trigger`, `vars` and `nodes` (`EXPRESSION_CONTEXT_ROOTS`). The picker's
 * `context.*` is the same payload as `trigger.*` (`prompt-scope.ts`), so it is written as
 * `trigger.*`; `consultation.*` and `run.*` are not readable from CEL this release and the picker
 * blocks them for a condition.
 */
import { parseExpression, type ExpressionNode } from '@arcaai/workflow-contract';

export type ConditionOperator = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contains' | 'startsWith' | 'endsWith' | 'isSet' | 'isNotSet';

export interface ConditionRule {
  /** A CEL path (`nodes.a.outputs.text`, `trigger.x`, `vars.y`). */
  field: string;
  operator: ConditionOperator;
  /** The comparison value as typed; ignored by `isSet` / `isNotSet`. */
  value: string;
}

export interface ConditionModel {
  join: 'all' | 'any';
  rules: ConditionRule[];
}

export const CONDITION_OPERATORS: ReadonlyArray<{ value: ConditionOperator; label: string; needsValue: boolean }> = [
  { value: 'eq', label: 'is', needsValue: true },
  { value: 'ne', label: 'is not', needsValue: true },
  { value: 'gt', label: 'is greater than', needsValue: true },
  { value: 'ge', label: 'is at least', needsValue: true },
  { value: 'lt', label: 'is less than', needsValue: true },
  { value: 'le', label: 'is at most', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'startsWith', label: 'starts with', needsValue: true },
  { value: 'endsWith', label: 'ends with', needsValue: true },
  { value: 'isSet', label: 'has a value', needsValue: false },
  { value: 'isNotSet', label: 'has no value', needsValue: false },
];

const COMPARISON: Partial<Record<ConditionOperator, string>> = { eq: '==', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=' };
const METHODS: ReadonlySet<ConditionOperator> = new Set(['contains', 'startsWith', 'endsWith']);

/** A picker path as CEL: `context.*` is the `trigger.*` root. */
export function celPathOf(raw: string): string {
  return raw === 'context' || raw.startsWith('context.') ? `trigger${raw.slice('context'.length)}` : raw;
}

/** Numbers and booleans as literals; everything else a quoted string. */
function literalOf(value: string): string {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed) || trimmed === 'true' || trimmed === 'false' || trimmed === 'null') return trimmed;
  return JSON.stringify(value);
}

function ruleToCel(rule: ConditionRule): string {
  if (rule.operator === 'isSet') return `has(${rule.field})`;
  if (rule.operator === 'isNotSet') return `!has(${rule.field})`;
  if (METHODS.has(rule.operator)) return `${rule.field}.${rule.operator}(${JSON.stringify(rule.value)})`;
  return `${rule.field} ${COMPARISON[rule.operator] as string} ${literalOf(rule.value)}`;
}

export function conditionToCel(model: ConditionModel): string {
  return model.rules
    .filter((rule) => rule.field.length > 0)
    .map(ruleToCel)
    .join(model.join === 'all' ? ' && ' : ' || ');
}

function pathOf(node: ExpressionNode): string | null {
  if (node.type === 'ident') return node.name;
  if (node.type === 'member') {
    const object = pathOf(node.object);
    return object === null ? null : `${object}.${node.field}`;
  }
  return null;
}

function valueText(node: ExpressionNode): string | null {
  if (node.type !== 'literal') return null;
  const value = node.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return null;
}

const COMPARISON_BY_OP: Record<string, ConditionOperator> = { '==': 'eq', '!=': 'ne', '>': 'gt', '>=': 'ge', '<': 'lt', '<=': 'le' };

function ruleOf(node: ExpressionNode): ConditionRule | null {
  if (node.type === 'call' && node.name === 'has' && node.args.length === 1) {
    const field = pathOf(node.args[0] as ExpressionNode);
    return field ? { field, operator: 'isSet', value: '' } : null;
  }
  if (node.type === 'unary' && node.op === '!') {
    const inner = ruleOf(node.operand);
    return inner?.operator === 'isSet' ? { ...inner, operator: 'isNotSet' } : null;
  }
  if (node.type === 'method' && METHODS.has(node.name as ConditionOperator) && node.args.length === 1) {
    const field = pathOf(node.target);
    const arg = node.args[0] as ExpressionNode;
    return field && arg.type === 'literal' && typeof arg.value === 'string' ? { field, operator: node.name as ConditionOperator, value: arg.value } : null;
  }
  if (node.type === 'binary' && COMPARISON_BY_OP[node.op]) {
    const field = pathOf(node.left);
    const value = valueText(node.right);
    return field && value !== null ? { field, operator: COMPARISON_BY_OP[node.op] as ConditionOperator, value } : null;
  }
  return null;
}

function flatten(node: ExpressionNode, op: '&&' | '||'): ExpressionNode[] {
  return node.type === 'binary' && node.op === op ? [...flatten(node.left, op), ...flatten(node.right, op)] : [node];
}

/** The rules an expression is made of, or `null` when the builder cannot represent it. */
export function celToCondition(cel: string): ConditionModel | null {
  if (cel.trim().length === 0) return { join: 'all', rules: [] };
  const parsed = parseExpression(cel);
  if ('error' in parsed) return null;
  const root = parsed.ast;
  const join: ConditionModel['join'] = root.type === 'binary' && root.op === '||' ? 'any' : 'all';
  const parts = flatten(root, join === 'all' ? '&&' : '||');
  const rules: ConditionRule[] = [];
  for (const part of parts) {
    const rule = ruleOf(part);
    if (rule === null) return null;
    rules.push(rule);
  }
  return { join, rules };
}
