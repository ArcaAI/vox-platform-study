#!/usr/bin/env node
/**
 * Extract class/method/interface metadata with exact 1-based line numbers from
 * the gateway and application packages. This is deliberately metadata-only:
 * the Python builder slices source text from the line ranges, so the JSON stays
 * small even though the repository is large.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromRepo = createRequire('/Users/apple/repos/VOX/project-hope/package.json');
const ts = requireFromRepo('typescript');

const repo = '/Users/apple/repos/VOX/project-hope';
const roots = [
  'apps/api/src',
  'packages/applications/src',
  'packages/domains/src',
  'packages/database/src',
];
const outFile = '/Users/apple/repos/VOX/review/api_explore_3/inventory/ts-symbols.json';

const skipParts = new Set(['__tests__', 'node_modules', 'dist', '.turbo', '__mocks__']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipParts.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts') && !/\.(test|spec)\.ts$/.test(full)) {
      files.push(full);
    }
  }
}
for (const root of roots) walk(path.join(repo, root));

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function endLineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}
function textOf(node) {
  return node ? node.getText() : '';
}
function decoratorsOf(node) {
  if (!node.decorators) return [];
  return node.decorators.map((d) => ({
    name: d.expression && ts.isCallExpression(d.expression) ? d.expression.expression.getText() : d.expression.getText(),
    args: d.expression && ts.isCallExpression(d.expression) ? d.expression.arguments.map((a) => a.getText()) : [],
    line: lineOf(node.getSourceFile(), d),
  }));
}
function paramsOf(node) {
  return (node.parameters || []).map((p) => ({
    name: p.name.getText(),
    type: p.type ? p.type.getText() : '',
    optional: Boolean(p.questionToken),
    decorators: decoratorsOf(p),
  }));
}
function heritageOf(node) {
  const out = { implements: [], extends: [] };
  for (const h of node.heritageClauses || []) {
    const names = h.types.map((t) => t.expression.getText());
    if (h.token === ts.SyntaxKind.ImplementsKeyword) out.implements.push(...names);
    else if (h.token === ts.SyntaxKind.ExtendsKeyword) out.extends.push(...names);
  }
  return out;
}
function methodsOf(sf, node) {
  const out = [];
  for (const member of node.members || []) {
    if (ts.isConstructorDeclaration(member)) {
      out.push({
        name: 'constructor',
        kind: 'constructor',
        line: lineOf(sf, member),
        endLine: endLineOf(sf, member),
        decorators: decoratorsOf(member),
        params: paramsOf(member),
        arrow: false,
      });
    } else if (ts.isMethodDeclaration(member) && member.name) {
      out.push({
        name: member.name.getText(),
        kind: 'method',
        line: lineOf(sf, member),
        endLine: endLineOf(sf, member),
        decorators: decoratorsOf(member),
        params: paramsOf(member),
        arrow: false,
      });
    } else if (ts.isPropertyDeclaration(member) && member.name) {
      const init = member.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        out.push({
          name: member.name.getText(),
          kind: 'property',
          line: lineOf(sf, member),
          endLine: endLineOf(sf, member),
          decorators: decoratorsOf(member),
          params: paramsOf(init),
          arrow: true,
        });
      }
    }
  }
  return out;
}

const result = { generatedAt: new Date().toISOString(), repo, files: {} };
for (const file of files) {
  const rel = path.relative(repo, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const symbols = [];
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const h = heritageOf(stmt);
      symbols.push({
        name: stmt.name.getText(),
        kind: 'class',
        abstract: Boolean(stmt.modifiers && stmt.modifiers.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)),
        line: lineOf(sf, stmt),
        endLine: endLineOf(sf, stmt),
        implements: h.implements,
        extends: h.extends,
        methods: methodsOf(sf, stmt),
      });
    } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      symbols.push({
        name: stmt.name.getText(),
        kind: 'interface',
        line: lineOf(sf, stmt),
        endLine: endLineOf(sf, stmt),
        implements: [],
        extends: [],
        methods: [],
      });
    }
  }
  if (symbols.length) result.files[rel] = { symbols };
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result));
console.log(JSON.stringify({ files: Object.keys(result.files).length, symbols: Object.values(result.files).reduce((n, f) => n + f.symbols.length, 0), outFile }, null, 2));
