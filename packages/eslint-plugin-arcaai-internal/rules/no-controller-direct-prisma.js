/**
 * TASK-307 W6.4 (AC-24) — no-controller-direct-prisma
 *
 * Forbids the `<receiver>.databaseService.client[...]` access chain inside
 * controller files. Controllers must go through a service or repository
 * (audit C-10 / F-1 / H-9). The rule is intentionally narrow — it
 * targets the canonical pattern used by the three pre-W6 offenders
 * (`AuthController`, `PoliciesController`, `RolesController`):
 *
 *     this.databaseService.client.user.findMany(...)
 *     const prisma = this.databaseService.client;
 *
 * Escape hatch: place a TSDoc block comment containing
 * `@allowedDirectPrisma <reason>` immediately above the offending line
 * (or above the enclosing statement) when direct access is genuinely
 * required. The allow-list should be empty after W6 ships; every entry
 * is a deliberate exception that must be reviewed.
 *
 *     /** @allowedDirectPrisma TASK-XXX: <one-sentence justification> *\/
 *     const row = await this.databaseService.client.foo.findFirst(...);
 *
 * The escape-hatch comment must appear within the previous 3 source
 * lines so reviewers can see the justification next to the bypass.
 *
 * The rule is wired by `base.js` via an `overrides` block scoped to
 * `apps/api/src/modules/**` — it does not affect domain / application
 * / database packages where direct Prisma access is legitimate
 * (service layer).
 */
'use strict';

const MAX_LINES_LOOK_BACK = 3;
const ALLOW_DIRECTIVE = /@allowedDirectPrisma(\s+([^*]+?))?\s*$/m;

/**
 * Walks the prefix of a member-expression chain to see if it ends in
 * `<...>.databaseService.client`. Returns true on a hit.
 *
 * Accepts both:
 *   this.databaseService.client            (ThisExpression base)
 *   foo.databaseService.client             (other identifier base; defensive)
 *
 * We don't recurse PAST `.client` — the rule only fires when the
 * chain ENDS at `.client`. Subsequent property accesses (`.user`,
 * `.findFirst`, etc.) are wrappers around the same MemberExpression
 * and would otherwise produce duplicate diagnostics.
 */
function isDirectPrismaAccess(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (node.computed) return false;
  if (!node.property || node.property.type !== 'Identifier' || node.property.name !== 'client') {
    return false;
  }

  const base = node.object;
  if (!base || base.type !== 'MemberExpression' || base.computed) return false;
  if (!base.property || base.property.type !== 'Identifier' || base.property.name !== 'databaseService') {
    return false;
  }

  return true;
}

function isStatementLike(node) {
  if (!node || !node.type) return false;
  return (
    node.type === 'ExpressionStatement' ||
    node.type === 'VariableDeclaration' ||
    node.type === 'ReturnStatement' ||
    node.type === 'IfStatement' ||
    node.type === 'ForStatement' ||
    node.type === 'ForOfStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'WhileStatement' ||
    node.type === 'DoWhileStatement' ||
    node.type === 'SwitchStatement' ||
    node.type === 'TryStatement' ||
    node.type === 'ThrowStatement' ||
    node.type === 'AwaitExpression' && node.parent && node.parent.type === 'ExpressionStatement'
  );
}

function commentSilences(sourceCode, node, anchorLine) {
  const commentsBefore = sourceCode.getCommentsBefore(node);
  for (const comment of commentsBefore) {
    const commentEndLine = comment.loc.end.line;
    if (anchorLine - commentEndLine > MAX_LINES_LOOK_BACK) continue;
    if (ALLOW_DIRECTIVE.test(comment.value)) return true;
  }
  return false;
}

function hasAllowDirective(sourceCode, node) {
  const anchorLine = node.loc.start.line;

  // 1. Comments immediately above the offending node itself.
  if (commentSilences(sourceCode, node, anchorLine)) return true;

  // 2. Walk up the AST to the enclosing statement / declaration /
  //    function, checking comments at each level. A single directive
  //    above the enclosing return / await expression / method /
  //    function declaration silences every direct-Prisma access inside.
  let current = node.parent;
  while (current) {
    if (
      isStatementLike(current) ||
      current.type === 'BlockStatement' ||
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'MethodDefinition' ||
      current.type === 'PropertyDefinition'
    ) {
      if (commentSilences(sourceCode, current, anchorLine)) return true;
      // Once we've checked the enclosing function/method, stop — anything
      // above is class-level and should not silence inner calls.
      if (
        current.type === 'MethodDefinition' ||
        current.type === 'FunctionDeclaration' ||
        current.type === 'PropertyDefinition'
      ) {
        break;
      }
    }
    current = current.parent;
  }

  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid `this.databaseService.client.*` access inside controller files. Use a service or repository (TASK-307 §W6 / audit C-10 / F-1 / H-9).',
      recommended: true,
    },
    schema: [],
    messages: {
      directPrismaInController:
        "Controllers must not access `this.databaseService.client` directly (TASK-307 W6.4 / audit C-10). Route through a service or repository. If this access is genuinely unavoidable, add `/** @allowedDirectPrisma <reason> */` immediately above this line.",
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();
    const reported = new WeakSet();

    function report(node) {
      if (reported.has(node)) return;
      reported.add(node);

      if (hasAllowDirective(sourceCode, node)) return;

      context.report({
        node,
        messageId: 'directPrismaInController',
      });
    }

    return {
      MemberExpression(node) {
        if (isDirectPrismaAccess(node)) {
          report(node);
        }
      },
    };
  },
};
