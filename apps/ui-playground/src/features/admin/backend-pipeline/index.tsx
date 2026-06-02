import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { usePipelines, type Pipeline, type PipelineVersion } from '@arcaai/vox';
import { CheckCircle2, History, Loader2, RefreshCw, Save, Star, XCircle } from 'lucide-react';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Textarea } from '@arcaai/ui/textarea';

import { Main } from '@/components/layout/main';

/**
 * TASK-328 A6 — Backend Pipeline admin page.
 *
 * Manages tenant `AsrPipeline`s through the `@arcaai/vox` `usePipelines` hook
 * (Q3): a YAML config editor (validate + save, which snapshots a new
 * `AsrPipelineVersion`), a versions list (view/diff-ready), an enable/disable
 * toggle (OCC via `If-Match`), and a set-default action. Tenant scoping is
 * carried by the SDK client (`X-Tenant-ID`), so no tenant arg is needed here.
 */

function isEnabled(p: Pipeline | undefined): boolean {
  return (p?.resourceStatus ?? 'ENABLED') !== 'DISABLED';
}

export default function BackendPipelinePage() {
  const { pipelines, isLoading, error, list, updatePipeline, validateConfig, setDefault, toggle, listVersions } = usePipelines();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [yamlDraft, setYamlDraft] = useState('');
  const [validation, setValidation] = useState<{ valid: boolean; errors?: string[] } | null>(null);
  const [versions, setVersions] = useState<PipelineVersion[]>([]);
  const [viewed, setViewed] = useState<PipelineVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const selected = useMemo(() => pipelines.find((p) => p.id === selectedId), [pipelines, selectedId]);

  const loadList = useCallback(() => {
    void list()
      .catch(() => undefined)
      .finally(() => setLoadedOnce(true));
  }, [list]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadVersions = useCallback(
    (id: string) => {
      void listVersions(id)
        .then(setVersions)
        .catch(() => setVersions([]));
    },
    [listVersions],
  );

  // Auto-select the tenant default (or the first pipeline) once the list lands.
  useEffect(() => {
    if (selectedId || pipelines.length === 0) return;
    const initial = pipelines.find((p) => p.isDefault) ?? pipelines[0];
    setSelectedId(initial.id);
  }, [pipelines, selectedId]);

  // Hydrate the editor + versions whenever the selection changes.
  useEffect(() => {
    if (!selected) return;
    setYamlDraft(selected.configYaml ?? '');
    setValidation(null);
    setViewed(null);
    loadVersions(selected.id);
  }, [selected, loadVersions]);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  const handleValidate = useCallback(async () => {
    try {
      const result = await validateConfig(yamlDraft);
      setValidation(result);
      if (result.valid) toast.success('Config is valid');
      else toast.error('Config has errors');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Validation failed');
    }
  }, [validateConfig, yamlDraft]);

  const handleSaveYaml = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await updatePipeline(selected.id, { configYaml: yamlDraft, expectedVersion: selected.version });
      toast.success('Pipeline config saved (new version snapshotted)');
      loadVersions(selected.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save pipeline config');
    } finally {
      setBusy(false);
    }
  }, [selected, updatePipeline, yamlDraft, loadVersions]);

  const handleSetDefault = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await setDefault(selected.id);
      toast.success(`"${selected.name}" is now the tenant default`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to set default');
    } finally {
      setBusy(false);
    }
  }, [selected, setDefault]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      setBusy(true);
      try {
        await toggle(selected.id, next, selected.version ?? 0);
        toast.success(next ? 'Pipeline enabled' : 'Pipeline disabled');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to toggle pipeline');
      } finally {
        setBusy(false);
      }
    },
    [selected, toggle],
  );

  return (
    <Main>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Backend Pipeline</h2>
          <p className="text-muted-foreground mt-1">ASR pipeline config, versions, default, and enablement for this tenant.</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadList} disabled={isLoading} aria-label="Reload pipelines">
          <RefreshCw data-icon="inline-start" className={isLoading ? 'animate-spin' : undefined} />
          Reload
        </Button>
      </div>

      {isLoading && !loadedOnce ? (
        <BackendPipelineSkeleton />
      ) : pipelines.length === 0 ? (
        <div
          className="bg-muted/20 text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm"
          data-testid="backend-pipeline-empty"
        >
          {error ? "Couldn't load pipelines for this tenant." : 'No ASR pipelines yet for this tenant.'}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]" data-testid="backend-pipeline">
          {/* Pipeline list */}
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-base">Pipelines</CardTitle>
              <CardDescription>{pipelines.length} total</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2" data-testid="backend-pipeline-list">
              {pipelines.map((p) => {
                const active = p.id === selectedId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`pipeline-row-${p.id}`}
                    onClick={() => handleSelect(p.id)}
                    className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                      active ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                    }`}
                    aria-pressed={active}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.isDefault && (
                        <Badge variant="secondary" className="gap-1">
                          <Star className="size-3" />
                          Default
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">{p.slug}</span>
                      <span className={`text-xs ${isEnabled(p) ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                        {isEnabled(p) ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {/* Detail */}
          {selected && (
            <div className="flex flex-col gap-6" data-testid="backend-pipeline-detail">
              {/* Controls */}
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {selected.name}
                      {selected.isDefault && (
                        <Badge variant="secondary" className="gap-1">
                          <Star className="size-3" />
                          Default
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>{selected.slug}</CardDescription>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="pipeline-enabled" className="text-sm">
                        {isEnabled(selected) ? 'Enabled' : 'Disabled'}
                      </Label>
                      <Switch
                        id="pipeline-enabled"
                        data-testid="toggle-switch"
                        checked={isEnabled(selected)}
                        onCheckedChange={handleToggle}
                        disabled={busy}
                        aria-label="Enable or disable pipeline"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="set-default-btn"
                      onClick={handleSetDefault}
                      disabled={busy || !!selected.isDefault}
                    >
                      <Star data-icon="inline-start" />
                      {selected.isDefault ? 'Default' : 'Set as default'}
                    </Button>
                  </div>
                </CardHeader>
              </Card>

              {/* YAML editor */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Configuration (YAML)</CardTitle>
                  <CardDescription>Validate, then save. Saving snapshots a new version.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Textarea
                    data-testid="yaml-editor"
                    aria-label="Pipeline YAML configuration"
                    spellCheck={false}
                    className="min-h-[260px] font-mono text-sm"
                    value={yamlDraft}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                      setYamlDraft(e.target.value);
                      setValidation(null);
                    }}
                  />
                  {validation && (
                    <div
                      data-testid="validation-result"
                      className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
                        validation.valid ? 'border-emerald-300 text-emerald-700' : 'border-destructive/40 text-destructive'
                      }`}
                      role="status"
                    >
                      {validation.valid ? <CheckCircle2 className="mt-0.5 size-4" /> : <XCircle className="mt-0.5 size-4" />}
                      <div>
                        {validation.valid ? 'Valid configuration.' : 'Invalid configuration:'}
                        {validation.errors && validation.errors.length > 0 && (
                          <ul className="ml-4 list-disc">
                            {validation.errors.map((e, i) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" data-testid="validate-btn" onClick={handleValidate} disabled={busy}>
                      <CheckCircle2 data-icon="inline-start" />
                      Validate
                    </Button>
                    <Button data-testid="save-yaml-btn" onClick={handleSaveYaml} disabled={busy}>
                      {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
                      Save config
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Versions */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <History className="size-4" />
                    Versions
                  </CardTitle>
                  <CardDescription>Each config save creates a snapshot.</CardDescription>
                </CardHeader>
                <CardContent>
                  {versions.length === 0 ? (
                    <p className="text-muted-foreground text-sm" data-testid="versions-empty">
                      No versions snapshotted yet.
                    </p>
                  ) : (
                    <ul className="flex flex-col divide-y" data-testid="versions-list">
                      {versions.map((v) => (
                        <li key={v.id} data-testid={`version-row-${v.versionNumber}`} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">v{v.versionNumber}</Badge>
                              <span className="text-muted-foreground truncate text-xs">{new Date(v.createdAt).toLocaleString()}</span>
                            </div>
                            {v.changeReason && <p className="text-muted-foreground mt-0.5 truncate text-xs">{v.changeReason}</p>}
                          </div>
                          <Button variant="ghost" size="sm" data-testid={`view-version-btn-${v.versionNumber}`} onClick={() => setViewed(v)}>
                            View
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {viewed && (
                    <div className="mt-4 flex flex-col gap-2" data-testid="viewed-version">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">Version {viewed.versionNumber} (read-only)</Label>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid="load-version-btn"
                          onClick={() => {
                            setYamlDraft(viewed.configYaml);
                            setValidation(null);
                            toast.success(`Loaded v${viewed.versionNumber} into the editor`);
                          }}
                        >
                          Load into editor
                        </Button>
                      </div>
                      <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs">{viewed.configYaml}</pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </Main>
  );
}

function BackendPipelineSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]" data-testid="backend-pipeline-skeleton">
      <Skeleton className="h-64 w-full rounded-xl" />
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  );
}
