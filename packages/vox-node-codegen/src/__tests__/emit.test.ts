import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { emitSurface } from '../emit';
import { generate } from '../run';
import { buildAdminSurface } from '../surface';
import { makeDocument, makeManifest } from './fixtures/tiny-surface';

function emitted(): Map<string, string> {
  const surface = buildAdminSurface(makeManifest(), makeDocument());
  return new Map(emitSurface(surface).map((file) => [file.relativePath, file.contents]));
}

describe('emitSurface', () => {
  const files = emitted();

  it('emits NO per-route scope list when every route declares exactly the area scope', () => {
    expect(files.get('widget.ts')).not.toContain('svcScopes:');
  });

  it('emits one module per area plus the schemas, namespace and barrel', () => {
    expect([...files.keys()].sort()).toEqual(['admin-namespace.ts', 'index.ts', 'schemas.ts', 'webhook-event.ts', 'widget.ts']);
  });

  it('declares the required svc: scope on the class and names it in the doc comment', () => {
    const widget = files.get('widget.ts') ?? '';
    expect(widget).toContain("readonly svcScope = 'svc:admin:widget:manage';");
    expect(widget).toContain('Required service-account scope: `svc:admin:widget:manage`');
  });

  it('uses the base class helpers rather than re-implementing pagination or If-Match', () => {
    const widget = files.get('widget.ts') ?? '';
    expect(widget).toContain('return this.listPage<WidgetResponse>');
    expect(widget).toContain('return this.listAll<WidgetResponse>');
    expect(widget).toContain('return this.requestWithPrecondition<WidgetResponse>');
    // Nothing hand-rolls the walk the base class documents as the trap.
    expect(widget).not.toContain('while (');
    expect(widget).not.toMatch(/If-Match['"]?\s*:/);
  });

  it('makes ifMatch a REQUIRED option on an @RequiresIfMatch route', () => {
    expect(files.get('widget.ts')).toContain('options: AdminRequestOptions & { ifMatch: IfMatchPrecondition }');
  });

  it('encodes interpolated path parameters', () => {
    expect(files.get('widget.ts')).toContain('`admin/widgets/${encodePathSegment(String(id))}`');
  });

  it('imports only real component schemas, never string-enum members', () => {
    const widget = files.get('widget.ts') ?? '';
    expect(widget).toContain("import type { UpdateWidgetRequest, WidgetResponse } from './schemas';");
    expect(widget).not.toContain('ApiKey');
  });

  it('passes a paired read route\'s OWN scopes to the base, on both the plain and the paginated path (O-3)', () => {
    const manifest = makeManifest();
    // `list` is the paginated route, `update` the plain one — cover both call
    // shapes, since they reach the base through different helpers.
    manifest.routes.find((r) => r.controller === 'WidgetController' && r.handler === 'list')!.svcScopes = [
      'svc:admin:widget:manage',
      'svc:admin:widget:read',
    ];
    manifest.routes.find((r) => r.controller === 'WidgetCatalogController' && r.handler === 'list')!.svcScopes = [
      'svc:admin:widget:manage',
      'svc:admin:widget:read',
    ];
    const paired = new Map(emitSurface(buildAdminSurface(manifest, makeDocument())).map((file) => [file.relativePath, file.contents]));
    const widget = paired.get('widget.ts') ?? '';

    expect(widget).toContain("this.listPage<WidgetResponse>('admin/widgets', options, ['svc:admin:widget:manage', 'svc:admin:widget:read'])");
    expect(widget).toContain("this.listAll<WidgetResponse>('admin/widgets', options, ['svc:admin:widget:manage', 'svc:admin:widget:read'])");
    expect(widget).toContain("svcScopes: ['svc:admin:widget:manage', 'svc:admin:widget:read']");
    // The class still advertises the one scope that reaches everything...
    expect(widget).toContain("readonly svcScope = 'svc:admin:widget:manage';");
    // ...and says, once, which routes accept more.
    expect(widget).toContain('ALSO accept `svc:admin:widget:read`');
    expect(widget).toContain('Reachable with ANY ONE of `svc:admin:widget:manage`, `svc:admin:widget:read`');
    // The routes that were NOT widened are untouched: `svcScopes:` appears
    // exactly once (the plain catalog route — the paginated one passes its
    // scopes positionally), so `update` carries none.
    expect(widget.match(/svcScopes:/g)).toHaveLength(1);
  });

  it('names every machine-closed controller in the barrel and the namespace', () => {
    expect(files.get('index.ts')).toContain('ConsentGrantController');
    expect(files.get('admin-namespace.ts')).toContain('ConsentGrantController');
  });

  it('never embeds a timestamp, version or environment value', () => {
    for (const contents of files.values()) {
      expect(contents).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(contents).not.toMatch(/\/(Users|home)\//);
    }
  });
});

describe('generate', () => {
  const inputs = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vox-node-codegen-'));
    const manifestPath = join(dir, 'route-manifest.json');
    const openApiPath = join(dir, 'openapi.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest()));
    writeFileSync(openApiPath, JSON.stringify(makeDocument()));
    return { dir, manifestPath, openApiPath, outDir: join(dir, 'admin') };
  };

  it('is idempotent — a second run produces a byte-identical tree', async () => {
    const paths = inputs();
    await generate(paths);
    const first = snapshot(paths.outDir);
    await generate(paths);
    expect(snapshot(paths.outDir)).toEqual(first);

    const check = await generate({ ...paths, check: true });
    expect(check.drifted).toEqual([]);
    expect(check.orphaned).toEqual([]);
  });

  it('reports a hand-edit as drift instead of silently overwriting it in --check mode', async () => {
    const paths = inputs();
    await generate(paths);
    writeFileSync(join(paths.outDir, 'widget.ts'), '// hand-edited\n');

    const check = await generate({ ...paths, check: true });
    expect(check.drifted).toEqual(['widget.ts']);
    // --check must not repair what it reports.
    expect(readFileSync(join(paths.outDir, 'widget.ts'), 'utf8')).toBe('// hand-edited\n');
  });

  it('reports and then deletes a generated module that no longer corresponds to an area', async () => {
    const paths = inputs();
    await generate(paths);
    writeFileSync(join(paths.outDir, 'ghost.ts'), 'export {};\n');

    expect((await generate({ ...paths, check: true })).orphaned).toEqual(['ghost.ts']);
    await generate(paths);
    expect(readdirSync(paths.outDir)).not.toContain('ghost.ts');
  });

  it('never touches the hand-authored base class', async () => {
    const paths = inputs();
    await generate(paths);
    writeFileSync(join(paths.outDir, 'admin-resource.ts'), '// hand-authored\n');

    const check = await generate({ ...paths, check: true });
    expect(check.orphaned).toEqual([]);
    await generate(paths);
    expect(readFileSync(join(paths.outDir, 'admin-resource.ts'), 'utf8')).toBe('// hand-authored\n');
  });
});

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), 'utf8');
  return out;
}
