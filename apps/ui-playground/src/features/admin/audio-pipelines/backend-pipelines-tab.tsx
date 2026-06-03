import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { usePipelines, type PipelineVersion } from '@arcaai/vox';
import { Building2, History, Loader2, Pencil, Plus, RefreshCw, Save, Star, Trash2, Workflow } from 'lucide-react';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';

import { useAuthStore } from '@/store/auth-store';

import { configToYaml, DEFAULT_CONFIG, PipelineConfigEditor } from './pipeline-config-editor';
import {
  useAudioPipelines,
  useCreateAudioPipeline,
  useDeleteAudioPipeline,
  useUpdateAudioPipeline,
  useValidateAudioPipelineYaml,
  type AudioPipeline,
} from '../api/audio-pipelines';
import { ConfirmDialog, StatusBadge } from '../components';

/**
 * TASK-331 doc-03 — Backend Pipelines tab of the consolidated Audio Pipelines
 * page.
 *
 * Unifies the two former pipeline surfaces that manage the SAME `AsrPipeline`
 * via the SAME `/admin/audio/pipelines` controller:
 *   - the legacy "Audio Pipelines" CRUD (list / create / edit / delete) via the
 *     admin `useAudioPipelines*` hooks (explicit `tenantId`), and
 *   - the "Backend Pipeline" management (set-default / enable-disable toggle /
 *     versions) via the `@arcaai/vox` `usePipelines` hook.
 *
 * Finding #4: tenant selection is the store `tenantId` (single source of
 * truth) — the in-page tenant picker that wrote the deprecated `setTenantKey`
 * is removed. A global-scope admin relies on the header ScopeSwitcher; with no
 * tenant selected the tab shows a "select a tenant" prompt and fires no
 * request. Finding #12: the editing tenant (`tenantName`) is shown in-page.
 * Finding #10: the delete confirmation reflects the backend soft-delete.
 */

const SLUG_PATTERN = /[^a-z0-9]+/g;

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(SLUG_PATTERN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function isEnabled(p: AudioPipeline | undefined): boolean {
  return (p?.resourceStatus ?? 'ENABLED') !== 'DISABLED';
}

const DEFAULT_YAML_TEMPLATE = configToYaml(DEFAULT_CONFIG);

interface EditDraft {
  name: string;
  slug: string;
  description: string;
  tags: string;
  configYaml: string;
}

function toDraft(p: AudioPipeline): EditDraft {
  return {
    name: p.name,
    slug: p.slug,
    description: p.description ?? '',
    tags: (p.tags ?? []).join(', '),
    configYaml: p.configYaml,
  };
}

export function BackendPipelinesTab() {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantName = useAuthStore((s) => s.tenantName);

  const needsTenant = isGlobalScope && !tenantId;
  const tenantLabel = tenantName || (tenantId ? `${tenantId.slice(0, 8)}\u2026` : '');

  const { data: pipelines, isLoading, isRefetching, refetch } = useAudioPipelines(tenantId);
  // TASK-328 A6 — set-default / toggle / versions ride the SDK client
  // (X-Tenant-ID), exactly as the former Backend Pipeline page did.
  const { setDefault, toggle, listVersions } = usePipelines();

  const updateMutation = useUpdateAudioPipeline(tenantId);
  const deleteMutation = useDeleteAudioPipeline(tenantId);
  const validateYaml = useValidateAudioPipelineYaml(tenantId);

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<PipelineVersion[]>([]);
  const [viewed, setViewed] = useState<PipelineVersion | null>(null);

  const prevSelectedRef = useRef('');

  const filtered = useMemo(() => {
    const all = pipelines ?? [];
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)));
  }, [pipelines, search]);

  const selected = useMemo(() => (pipelines ?? []).find((p) => p.id === selectedId), [pipelines, selectedId]);

  // Reset selection whenever the active tenant changes.
  useEffect(() => {
    setSelectedId('');
    setIsEditing(false);
    prevSelectedRef.current = '';
  }, [tenantId]);

  // Auto-select the tenant default (or the first pipeline) once the list lands.
  // No tenant selected (global scope) ⇒ no list, no selection, no requests.
  useEffect(() => {
    if (needsTenant || selectedId || !pipelines || pipelines.length === 0) return;
    const initial = pipelines.find((p) => p.isDefault) ?? pipelines[0];
    setSelectedId(initial.id);
  }, [pipelines, selectedId, needsTenant]);

  // Clear the selection if the current pick is filtered out.
  useEffect(() => {
    if (selectedId && !filtered.some((p) => p.id === selectedId)) {
      setSelectedId('');
    }
  }, [filtered, selectedId]);

  const loadVersions = useCallback(
    (id: string) => {
      void listVersions(id)
        .then(setVersions)
        .catch(() => setVersions([]));
    },
    [listVersions],
  );

  // Hydrate edit drafts + versions when the selection changes; reload versions
  // on background refetches without resetting the editor.
  useEffect(() => {
    if (!selected) {
      setVersions([]);
      setViewed(null);
      return;
    }
    if (prevSelectedRef.current !== selected.id) {
      prevSelectedRef.current = selected.id;
      setIsEditing(false);
      setDraft(toDraft(selected));
      setViewed(null);
    }
    loadVersions(selected.id);
  }, [selected, loadVersions]);

  const handleSetDefault = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await setDefault(selected.id);
      toast.success(`"${selected.name}" is now the tenant default`);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to set default');
    } finally {
      setBusy(false);
    }
  }, [selected, setDefault, refetch]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      setBusy(true);
      try {
        await toggle(selected.id, next, selected.version ?? 0);
        toast.success(next ? 'Pipeline enabled' : 'Pipeline disabled');
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to toggle pipeline');
      } finally {
        setBusy(false);
      }
    },
    [selected, toggle, refetch],
  );

  const handleSaveEdit = useCallback(async () => {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const validation = await validateYaml.mutateAsync(draft.configYaml);
      if (!validation.valid) {
        toast.error(`Cannot save changes. YAML configuration is invalid${validation.errors?.length ? `: ${validation.errors.join(', ')}` : '.'}`);
        return;
      }
      const expectedVersion = typeof selected.version === 'number' ? selected.version : 1;
      await updateMutation.mutateAsync({
        id: selected.id,
        name: draft.name,
        slug: draft.slug,
        description: draft.description || undefined,
        configYaml: draft.configYaml,
        tags: parseTags(draft.tags),
        expectedVersion,
        ifMatch: `"${expectedVersion}"`,
      });
      toast.success('Pipeline updated successfully (new version snapshotted)');
      setIsEditing(false);
      loadVersions(selected.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update pipeline');
    } finally {
      setBusy(false);
    }
  }, [selected, draft, validateYaml, updateMutation, loadVersions]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await deleteMutation.mutateAsync(selected.id);
      toast.success('Pipeline deleted');
      setShowDeleteConfirm(false);
      setSelectedId('');
      prevSelectedRef.current = '';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete pipeline');
    } finally {
      setBusy(false);
    }
  }, [selected, deleteMutation]);

  const loadVersionIntoEditor = useCallback(() => {
    if (!viewed) return;
    setDraft((d) => ({ ...(d ?? toDraftEmpty()), configYaml: viewed.configYaml }));
    setIsEditing(true);
    toast.success(`Loaded v${viewed.versionNumber} into the editor`);
  }, [viewed]);

  // ── Global scope with no tenant — explicit prompt, no request fired. ──
  if (needsTenant) {
    return (
      <div
        className="bg-muted/20 text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm"
        data-testid="backend-pipelines-select-tenant"
      >
        <Building2 className="size-8 opacity-60" />
        <p className="text-foreground text-sm font-medium">Select a tenant</p>
        <p>Pick a tenant from the switcher in the header to manage its backend ASR pipelines.</p>
      </div>
    );
  }

  if (isLoading && !pipelines) {
    return <BackendPipelinesSkeleton />;
  }

  const list = pipelines ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="backend-pipelines">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Editing tenant:</span>
          <Badge variant="outline" className="gap-1.5" data-testid="backend-pipelines-tenant">
            <Building2 className="size-3.5" />
            {tenantLabel || 'Current tenant'}
          </Badge>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching} aria-label="Reload pipelines">
          <RefreshCw data-icon="inline-start" className={isRefetching ? 'animate-spin' : undefined} />
          Reload
        </Button>
      </div>

      {list.length === 0 ? (
        <div
          className="bg-muted/20 text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center text-sm"
          data-testid="backend-pipelines-empty"
        >
          <Workflow className="size-10 opacity-50" />
          <div>
            <p className="text-foreground text-sm font-medium">No ASR pipelines yet for this tenant</p>
            <p>Create your first backend pipeline to get started.</p>
          </div>
          <Button data-testid="create-pipeline-btn" onClick={() => setShowCreate(true)}>
            <Plus data-icon="inline-start" />
            Create pipeline
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]" data-testid="backend-pipelines-grid">
          {/* Pipeline list */}
          <Card className="h-fit">
            <CardHeader className="gap-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Pipelines</CardTitle>
                  <CardDescription>{list.length} total</CardDescription>
                </div>
                <Button size="sm" data-testid="create-pipeline-btn" onClick={() => setShowCreate(true)}>
                  <Plus data-icon="inline-start" />
                  New
                </Button>
              </div>
              <Input
                value={search}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                placeholder="Search pipelines..."
                aria-label="Search pipelines"
                spellCheck={false}
                autoComplete="off"
                className="h-8"
              />
            </CardHeader>
            <CardContent className="flex flex-col gap-2" data-testid="backend-pipelines-list">
              {filtered.map((p) => {
                const active = p.id === selectedId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`pipeline-row-${p.id}`}
                    onClick={() => setSelectedId(p.id)}
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
                      <span className="text-muted-foreground font-mono text-xs">{p.slug}</span>
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
          {selected ? (
            <div className="flex flex-col gap-6" data-testid="backend-pipelines-detail">
              {/* Controls */}
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <span className="truncate">{selected.name}</span>
                      {selected.isDefault && (
                        <Badge variant="secondary" className="gap-1">
                          <Star className="size-3" />
                          Default
                        </Badge>
                      )}
                      <StatusBadge status={selected.resourceStatus} />
                    </CardTitle>
                    <CardDescription className="font-mono">{selected.slug}</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-3">
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
                    {!isEditing && (
                      <>
                        <Button variant="outline" size="sm" data-testid="edit-btn" onClick={() => setIsEditing(true)} disabled={busy}>
                          <Pencil data-icon="inline-start" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          data-testid="delete-btn"
                          onClick={() => setShowDeleteConfirm(true)}
                          disabled={busy}
                        >
                          <Trash2 data-icon="inline-start" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </CardHeader>
              </Card>

              {/* Config editor */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Configuration</CardTitle>
                  <CardDescription>
                    {isEditing
                      ? 'Edit and save. Saving validates the YAML and snapshots a new version.'
                      : 'Read-only. Use Edit to change the configuration.'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {isEditing && draft ? (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="edit-name">Name</Label>
                          <Input
                            id="edit-name"
                            data-testid="edit-name"
                            value={draft.name}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              setDraft((d) => ({ ...(d ?? toDraftEmpty()), name: e.target.value }))
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="edit-slug">Slug</Label>
                          <Input
                            id="edit-slug"
                            data-testid="edit-slug"
                            spellCheck={false}
                            value={draft.slug}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              setDraft((d) => ({ ...(d ?? toDraftEmpty()), slug: e.target.value }))
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-2 sm:col-span-2">
                          <Label htmlFor="edit-tags">Tags</Label>
                          <Input
                            id="edit-tags"
                            data-testid="edit-tags"
                            placeholder="production, high-quality"
                            value={draft.tags}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              setDraft((d) => ({ ...(d ?? toDraftEmpty()), tags: e.target.value }))
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-2 sm:col-span-2">
                          <Label htmlFor="edit-description">Description</Label>
                          <Input
                            id="edit-description"
                            data-testid="edit-description"
                            value={draft.description}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              setDraft((d) => ({ ...(d ?? toDraftEmpty()), description: e.target.value }))
                            }
                          />
                        </div>
                      </div>
                      <PipelineConfigEditor
                        value={draft.configYaml}
                        onChange={(yaml: string) => setDraft((d) => ({ ...(d ?? toDraftEmpty()), configYaml: yaml }))}
                        rows={16}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          data-testid="cancel-edit-btn"
                          onClick={() => {
                            if (selected) setDraft(toDraft(selected));
                            setIsEditing(false);
                          }}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          data-testid="save-edit-btn"
                          onClick={handleSaveEdit}
                          disabled={busy || validateYaml.isPending || updateMutation.isPending}
                        >
                          {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
                          Save config
                        </Button>
                      </div>
                    </>
                  ) : (
                    <PipelineConfigEditor value={selected.configYaml} readOnly />
                  )}
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
                        <Button variant="ghost" size="sm" data-testid="load-version-btn" onClick={loadVersionIntoEditor}>
                          Load into editor
                        </Button>
                      </div>
                      <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs">{viewed.configYaml}</pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 py-16">
              <Workflow className="size-10 opacity-50" />
              <p className="text-sm">Select a pipeline to view its configuration</p>
            </div>
          )}
        </div>
      )}

      <CreatePipelineDialog open={showCreate} onOpenChange={setShowCreate} tenantId={tenantId} />

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Pipeline"
        description={`This moves "${selected?.name ?? 'the pipeline'}" to deleted (soft-delete); it can be restored by an administrator.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending || busy}
      />
    </div>
  );
}

function toDraftEmpty(): EditDraft {
  return { name: '', slug: '', description: '', tags: '', configYaml: DEFAULT_YAML_TEMPLATE };
}

function CreatePipelineDialog({ open, onOpenChange, tenantId }: { open: boolean; onOpenChange: (open: boolean) => void; tenantId: string }) {
  const createMutation = useCreateAudioPipeline(tenantId);
  const validateYaml = useValidateAudioPipelineYaml(tenantId);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [configYaml, setConfigYaml] = useState(DEFAULT_YAML_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setName('');
    setSlug('');
    setSlugEdited(false);
    setDescription('');
    setTags('');
    setConfigYaml(DEFAULT_YAML_TEMPLATE);
  }, []);

  const handleNameChange = useCallback(
    (value: string) => {
      setName(value);
      if (!slugEdited) setSlug(generateSlug(value));
    },
    [slugEdited],
  );

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !slug.trim()) {
      toast.error('Name and slug are required.');
      return;
    }
    setSubmitting(true);
    try {
      const validation = await validateYaml.mutateAsync(configYaml);
      if (!validation.valid) {
        toast.error(`Cannot create pipeline. YAML configuration is invalid${validation.errors?.length ? `: ${validation.errors.join(', ')}` : '.'}`);
        return;
      }
      await createMutation.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        description: description || undefined,
        configYaml,
        tags: parseTags(tags),
      });
      toast.success('Pipeline created successfully');
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create pipeline');
    } finally {
      setSubmitting(false);
    }
  }, [name, slug, description, tags, configYaml, validateYaml, createMutation, reset, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl min-w-[40vw]" data-testid="create-pipeline-dialog">
        <DialogHeader>
          <DialogTitle>Create Audio Pipeline</DialogTitle>
          <DialogDescription>Define a new backend ASR pipeline with model references and processing parameters.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto pr-1">
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-name">Name</Label>
            <Input
              id="create-name"
              data-testid="create-name"
              placeholder="e.g., Production Pipeline (Whisper Large V3)"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleNameChange(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-slug">Slug</Label>
            <Input
              id="create-slug"
              data-testid="create-slug"
              spellCheck={false}
              placeholder="e.g., production-whisper-large-v3"
              value={slug}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-description">Description</Label>
            <Input
              id="create-description"
              data-testid="create-description"
              placeholder="Describe the pipeline purpose..."
              value={description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-tags">Tags</Label>
            <Input
              id="create-tags"
              data-testid="create-tags"
              placeholder="production, high-quality, recommended"
              value={tags}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTags(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Pipeline Configuration</Label>
            <PipelineConfigEditor value={configYaml} onChange={setConfigYaml} rows={14} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            data-testid="create-submit"
            onClick={handleSubmit}
            disabled={submitting || createMutation.isPending || validateYaml.isPending}
          >
            {(submitting || createMutation.isPending || validateYaml.isPending) && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Create Pipeline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackendPipelinesSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]" data-testid="backend-pipelines-skeleton">
      <Skeleton className="h-64 w-full rounded-xl" />
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  );
}
