/**
 * require-api-key-justification  (TASK-761, gate G3 — the justification half)
 *
 * A `@ForbidApiKey()` on a BUSINESS-plane controller must carry an
 * `// API-KEY-NOTE` saying why, in prose, at the decorator.
 *
 * ## Why lint and not a boot audit
 *
 * The rest of G3 is already mechanical and already lives in
 * `apps/api/src/bootstrap/`:
 *
 *   - PRESENCE — every API-key-reachable route declares `@RequiredScopes(...)`
 *     or `@ForbidApiKey()` (`api-key-surface-audit.ts`, TASK-742).
 *   - VALUE — a business-plane `@ForbidApiKey()` must be named in
 *     `BUSINESS_PLANE_KEY_FORBIDDEN` (`business-plane-apikey-exemptions-audit.ts`,
 *     TASK-758).
 *
 * Both read resolved Nest metadata through a `Reflector`, which is the right
 * mechanism for a fact about the application graph. A REASON is not such a
 * fact: it is a comment, and comments are gone before any metadata exists —
 * `tsc` strips them, so no boot audit anywhere can ever read one. Source text
 * is the only place a justification lives, and ESLint is the only tool in this
 * repo that reads source text. That is the whole argument, and it is why this
 * rule is not "a second copy of the audit in a different place".
 *
 * ## Marker: `API-KEY-NOTE` only (owner decision, 2026-08-18)
 *
 * The tree carries two deliberately distinct markers:
 *
 *   - `// API-KEY-NOTE` — the API-key CLASSIFICATION of a surface. This rule.
 *   - `// AUTH-NOTE` — the `.claude/rules/05-nestjs-api.md` marker for
 *     "the permission decorator understates the real gate" (an imperative
 *     privilege check in the service).
 *
 * They answer different questions, so accepting either was explicitly
 * REJECTED: a rule that took both would let an `AUTH-NOTE` about a CASL gate
 * stand in as an explanation of an API-key decision, which it never is. There
 * is no comment migration — all four business-plane `@ForbidApiKey()`
 * controllers in the tree already carry `API-KEY-NOTE`.
 *
 * ## Which planes this rule judges
 *
 * Only the business plane, because only there is the decorator a JUDGEMENT:
 *
 *   - `admin/*` is JWT-only by blanket policy A2 (TASK-757) and every one of
 *     the ~70 admin controllers carries `@ForbidApiKey()` for the same
 *     structural reason. Demanding 70 copies of one sentence would be noise
 *     that teaches people to paste rather than think, and A2 is already
 *     enforced by `auditAdminControllersDeclareNoApiKeyScopes`.
 *   - `internal/*` is off the API-key surface entirely
 *     (`auditInternalRoutesOffApiKeySurface`, TASK-708).
 *
 * A controller whose `@Controller(...)` argument is not a string literal FAILS
 * CLOSED (the note is required): the plane cannot be proven from source, and an
 * unprovable plane is not the same as an exempt one.
 *
 * A class carrying `@ForbidApiKey()` with NO `@Controller` at all is skipped —
 * it is not a mounted route surface, and the boot audits cover everything that
 * is actually registered.
 *
 * Wired in `packages/config-eslint/flat/core.js` for
 * `modules/**` controller files, the same scope shape as
 * `no-controller-direct-prisma`.
 */
'use strict';

const FORBID_DECORATOR = 'ForbidApiKey';
const CONTROLLER_DECORATOR = 'Controller';

/** Planes whose `@ForbidApiKey()` is blanket policy rather than a per-surface decision. */
const EXEMPT_PLANE_PREFIXES = ['admin', 'internal'];

const MARKER = 'API-KEY-NOTE';

/**
 * Minimum prose length after the marker. Twelve characters is deliberately low:
 * the rule's job is to stop a marker used as a rubber stamp (`// API-KEY-NOTE`,
 * `// API-KEY-NOTE:`), not to grade writing.
 */
const MIN_PROSE_LENGTH = 12;

/** The callee name of a decorator, for both `@Foo` and `@Foo(...)` forms. */
function decoratorName(decorator) {
  const expr = decorator.expression;
  if (!expr) return null;
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier') return expr.callee.name;
  return null;
}

function findDecorator(node, name) {
  return (node.decorators ?? []).find((d) => decoratorName(d) === name) ?? null;
}

/**
 * The plane of a class, read off its `@Controller(...)` path argument.
 * Returns `'exempt'` (admin/internal), `'business'`, or `null` when the class
 * is not a controller at all.
 */
function classPlane(classNode) {
  const controller = findDecorator(classNode, CONTROLLER_DECORATOR);
  if (!controller) return null;

  const expr = controller.expression;
  const firstArg = expr.type === 'CallExpression' ? expr.arguments[0] : undefined;

  // `@Controller()` with no path mounts at the global prefix root — business.
  if (firstArg === undefined) return 'business';

  // Anything not a plain string literal (a constant, a template, an options
  // object) cannot be resolved here. Fail closed.
  if (firstArg.type !== 'Literal' || typeof firstArg.value !== 'string') return 'business';

  const first = firstArg.value.replace(/^\/+/, '').split('/')[0];
  return EXEMPT_PLANE_PREFIXES.includes(first) ? 'exempt' : 'business';
}

/**
 * Every comment in the decorator region of `node` — the comments before the
 * node itself (its leading block) and before each of its decorators. Placing
 * the note above `@Controller` rather than above `@ForbidApiKey()` is a
 * formatting choice, not a different declaration, so both count.
 */
function decoratorRegionComments(node, sourceCode) {
  const seen = new Map();
  const collect = (target) => {
    for (const comment of sourceCode.getCommentsBefore(target)) {
      seen.set(`${comment.range[0]}:${comment.range[1]}`, comment);
    }
  };

  collect(node);
  for (const decorator of node.decorators ?? []) collect(decorator);
  // An exported class puts the decorators inside the ExportNamedDeclaration,
  // whose own leading comments are the ones a human sees above the class.
  if (node.parent && node.parent.type === 'ExportNamedDeclaration') collect(node.parent);

  return [...seen.values()].sort((a, b) => a.range[0] - b.range[0]);
}

/**
 * Verdict for a set of comments: `'ok'`, `'empty'` (marker present, no prose),
 * or `'missing'` (no marker at all).
 */
function judgeComments(comments) {
  const markerIndex = comments.findIndex((c) => c.value.includes(MARKER));
  if (markerIndex === -1) return 'missing';

  // Prose may continue onto the following comment lines of the same block, so
  // read from the marker to the end of the collected region.
  const first = comments[markerIndex].value;
  const afterMarker = first.slice(first.indexOf(MARKER) + MARKER.length);
  const rest = comments
    .slice(markerIndex + 1)
    .map((c) => c.value)
    .join(' ');

  // Strip separators/decoration so `// API-KEY-NOTE: —` cannot pass as prose.
  const prose = `${afterMarker} ${rest}`.replace(/[\s*:—–\-.,;]+/g, '');
  return prose.length >= MIN_PROSE_LENGTH ? 'ok' : 'empty';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an `// API-KEY-NOTE` with a written reason on every business-plane `@ForbidApiKey()` (TASK-761 gate G3). The boot audits pin that the exemption is NAMED; only source text can carry WHY.',
      recommended: true,
    },
    schema: [],
    messages: {
      missingApiKeyNote:
        "This business-plane route forbids API keys with no recorded reason. Policy A1 (TASK-758) says a non-admin route is JWT + API key, so `@ForbidApiKey()` here is a REASONED EXEMPTION: add an `// API-KEY-NOTE — <why>` at the decorator saying what a long-lived static credential must never reach (biometrics, a personal model, the credential-issuing plane, ...). `// AUTH-NOTE` does NOT satisfy this — it is the rule-05 marker for a permission decorator that understates the real gate, which is a different question. If the surface should simply accept keys, declare `@RequiredScopes('<scope>')` instead; that is one line and needs no note.",
      emptyApiKeyNote:
        "The `// API-KEY-NOTE` here carries no reason — a bare marker is a rubber stamp, not a justification. Write what a long-lived static credential must never reach on this surface, and why JWT-only is the answer.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** Report on a `@ForbidApiKey()` decorator whose justification region is `comments`. */
    function check(decorator, comments) {
      const verdict = judgeComments(comments);
      if (verdict === 'ok') return;
      context.report({
        node: decorator,
        messageId: verdict === 'empty' ? 'emptyApiKeyNote' : 'missingApiKeyNote',
      });
    }

    return {
      ClassDeclaration(classNode) {
        const plane = classPlane(classNode);
        if (plane !== 'business') return;

        const classForbid = findDecorator(classNode, FORBID_DECORATOR);
        if (classForbid) check(classForbid, decoratorRegionComments(classNode, sourceCode));

        for (const member of classNode.body?.body ?? []) {
          if (member.type !== 'MethodDefinition' && member.type !== 'PropertyDefinition') continue;
          const memberForbid = findDecorator(member, FORBID_DECORATOR);
          if (!memberForbid) continue;
          check(memberForbid, decoratorRegionComments(member, sourceCode));
        }
      },
    };
  },
};
