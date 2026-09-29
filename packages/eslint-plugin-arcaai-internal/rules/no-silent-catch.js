/**
 * no-silent-catch
 *
 * Forbids the two ways an error disappears without a trace:
 *
 *   await repo.findById(id).catch(() => null);      // ERROR (also [], undefined, {})
 *   try { await work(); } catch {}                  // ERROR (empty catch block)
 *
 * Both turn an infrastructure failure (database down, network reset) into a
 * value the caller reads as "there is nothing there" — a 404 for an outage, a
 * blank screen for a permission error. The replacement is a handler that
 * answers only the legitimate miss (a not-found) and logs + rethrows anything
 * else; where the swallow is genuinely intended, say so and why:
 *
 *   await cache.evict(key).catch(() => undefined); // swallow-ok: best-effort eviction, the TTL is the backstop
 *
 * The marker `swallow-ok: <reason>` (a non-empty reason is required) is honoured
 * on the offending line, on the line above it, or — for an empty `catch {}` —
 * anywhere inside the block.
 *
 * Wired at `warn` in `packages/config-eslint/flat/core.js` for
 * `src/services/**` and `src/modules/**`.
 */
'use strict';

const MARKER = /swallow-ok:\s*\S/;
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression']);

function unwrap(node) {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** `null`, `undefined`, `void 0`, `[]`, `{}` — a value that says "nothing here". */
function isEmptyValue(node) {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === 'Literal') return value.value === null && value.raw === 'null';
  if (value.type === 'Identifier') return value.name === 'undefined';
  if (value.type === 'ArrayExpression') return value.elements.length === 0;
  if (value.type === 'ObjectExpression') return value.properties.length === 0;
  if (value.type === 'UnaryExpression') return value.operator === 'void';
  return false;
}

function isSwallowingHandler(fn) {
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return false;
  if (fn.body.type !== 'BlockStatement') return isEmptyValue(fn.body);
  const statements = fn.body.body;
  if (statements.length === 0) return true;
  return statements.length === 1 && statements[0].type === 'ReturnStatement' && (statements[0].argument === null || isEmptyValue(statements[0].argument));
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Forbid `.catch(() => null | [] | undefined | {})` and empty `catch {}` blocks; a deliberate swallow needs `// swallow-ok: <reason>`.',
      recommended: false,
    },
    schema: [],
    messages: {
      silentCatchHandler:
        'This `.catch()` turns every failure into an empty value, so an outage reads as "not found". Answer only the not-found case and log + rethrow the rest, or add `// swallow-ok: <reason>`.',
      silentCatchBlock:
        'Empty `catch` block: the error vanishes without a trace. Log it (with the ids in scope) and rethrow, or add `// swallow-ok: <reason>`.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function hasMarker(firstLine, lastLine) {
      return sourceCode.getAllComments().some((comment) => MARKER.test(comment.value) && comment.loc.start.line >= firstLine && comment.loc.end.line <= lastLine);
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'catch') return;
        if (node.arguments.length !== 1 || !isSwallowingHandler(node.arguments[0])) return;
        if (hasMarker(callee.property.loc.start.line - 1, node.loc.end.line)) return;
        context.report({ node: callee.property, messageId: 'silentCatchHandler' });
      },

      CatchClause(node) {
        if (node.body.body.length !== 0) return;
        if (hasMarker(node.loc.start.line - 1, node.loc.end.line)) return;
        context.report({ node, messageId: 'silentCatchBlock' });
      },
    };
  },
};
