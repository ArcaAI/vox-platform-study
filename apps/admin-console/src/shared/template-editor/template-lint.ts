/**
 * The console side of schema-aware prompt editing: what `TemplateEditor` offers (completion paths)
 * and what it squiggles (lint), both derived from the contract functions the server's publish gate
 * uses — `schemaVariablePaths` for the vocabulary and `templateReferenceProblems` for the verdict —
 * so "what the editor suggests" and "what publish accepts" cannot drift into two rule sets.
 *
 * The one approximation: the contract checks a reference against the run's PAYLOAD schema, which
 * the console does not have; the namespace roots here are rebuilt from the path list instead. Every
 * level that lists children is closed (an unknown child is reported), every leaf is open (anything
 * below it is admitted), which is exactly as strict as the path list is deep.
 */
import {
  schemaVariablePaths,
  templateReferenceProblems,
  templateReferences,
  templateSyntaxProblems,
  type DeclaredNamespaces,
} from '@arcaai/workflow-contract';
import type { TemplateDiagnostic, VariablePath } from '@arcaai/ui/components/custom/template-editor';

/** The `context.*` AND `trigger.*` paths of one context-schema definition (the two roots publish declares for an agent). */
export function contextVariablePaths(definition: unknown): VariablePath[] {
  if (definition === null || definition === undefined) return [];
  return [...schemaVariablePaths(definition, 'context'), ...schemaVariablePaths(definition, 'trigger')];
}

/** Bare variable names (an agent's `instruction.variables`, a template's declarations) as completion entries. */
export function variableNamePaths(names: readonly string[], type = 'variable'): VariablePath[] {
  return [...new Set(names)].filter((name) => name.length > 0).map((path) => ({ path, type, required: false, phiClass: null, description: null, deprecated: false }));
}

interface SchemaNode {
  type: 'object';
  properties: Record<string, SchemaNode>;
  additionalProperties?: false;
}

/** A namespace root's schema rebuilt from its paths — closed where children are listed, open at the leaves. */
function rootSchema(paths: readonly VariablePath[], root: string): SchemaNode | null {
  const prefix = `${root}.`;
  const own = paths.filter((entry) => entry.path.startsWith(prefix));
  if (own.length === 0) return null;
  const tree: SchemaNode = { type: 'object', properties: {} };
  for (const entry of own) {
    let node = tree;
    for (const segment of entry.path.slice(prefix.length).split('.')) {
      node.additionalProperties = false;
      node.properties[segment] ??= { type: 'object', properties: {} };
      node = node.properties[segment];
    }
  }
  return tree;
}

export interface DeclaredNamespacesInput {
  /** The bound (or inherited) context-schema version definition; `null` when none is bound. */
  definition: unknown;
  /** Bare names the scope binds. */
  variables: readonly string[];
  /** Extra roots whose shape this editor cannot know (`input`, `vars`, `nodes`, …) — admitted as open. */
  openRoots?: readonly string[];
}

/** The same `DeclaredNamespaces` shape publish builds: `context` + `trigger` from the schema, plus open roots. */
export function declaredNamespaces({ definition, variables, openRoots = ['input'] }: DeclaredNamespacesInput): DeclaredNamespaces {
  const roots: Record<string, unknown> = Object.fromEntries(openRoots.map((root) => [root, null]));
  if (definition !== null && definition !== undefined) {
    const paths = contextVariablePaths(definition);
    for (const root of ['context', 'trigger']) roots[root] = rootSchema(paths, root);
  }
  return { roots, variables };
}

const OFFSET = /at offset (\d+)/;

function syntaxDiagnostics(content: string): TemplateDiagnostic[] {
  return templateSyntaxProblems(content).map((message) => {
    const from = Number(OFFSET.exec(message)?.[1] ?? 0);
    return { from, to: Math.min(content.length, from + 2), message, severity: 'error' as const };
  });
}

/**
 * Syntax-only lint, for a body whose namespaces are decided later by whatever binds it (a shared
 * prompt template is bound by agents, each with its own schema and variables).
 */
export function templateSyntaxLint(content: string): TemplateDiagnostic[] {
  return syntaxDiagnostics(content);
}

/** Whole-document lint for `TemplateEditor`: syntax first (a template that does not parse has no references), then one squiggle per offending placeholder. */
export function templateLint(declared: DeclaredNamespaces): (content: string) => TemplateDiagnostic[] {
  return (content) => {
    const syntax = syntaxDiagnostics(content);
    if (syntax.length > 0) return syntax;
    const diagnostics: TemplateDiagnostic[] = [];
    for (const reference of templateReferences(content)) {
      if (reference.hasDefault) continue;
      const close = content.indexOf('}}', reference.offset);
      const to = close === -1 ? content.length : close + 2;
      const [problem] = templateReferenceProblems(content.slice(reference.offset, to), declared);
      if (problem) diagnostics.push({ from: reference.offset, to, message: problem, severity: 'error' });
    }
    return diagnostics;
  };
}

export interface FieldFinding {
  severity: 'ERROR' | 'WARNING' | 'INFO' | string;
  code: string;
  path: string;
  message: string;
}

/** Server findings whose `path` names this field — exactly, or (with `prefix`) anything nested under it. */
export function findingsAt<T extends FieldFinding>(findings: readonly T[] | null | undefined, path: string, options?: { prefix?: boolean }): T[] {
  return (findings ?? []).filter(
    (finding) => finding.path === path || (options?.prefix === true && (finding.path.startsWith(`${path}.`) || finding.path.startsWith(`${path}[`))),
  );
}
