/**
 * SavedSummariesPanel (TASK-329 P6)
 *
 * Consultation-scoped management surface for persisted summaries:
 *   - list a consultation's summaries (with cacheHit / qualityScore badges)
 *   - browse a summary's version history
 *   - diff two versions (rendered via the shared VersionDiffPanel)
 *   - tag a summary (add / remove polymorphic Tag rows)
 *   - edit a summary, which creates a NEW version server-side
 *
 * All data flows through the @arcaai/vox `useArcaSummary` hook (Q3). The panel
 * operates on the SDK store's active consultation (`useArca().session`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useArca, useArcaSummary, type SummaryResponse, type SummaryTag, type SummaryVersionEntry, type VersionDiff } from '@arcaai/vox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Input } from '@arcaai/ui/input';
import { Textarea } from '@arcaai/ui/textarea';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { FileText, GitCompare, Loader2, Plus, Save, Sparkles, Tag as TagIcon, X } from 'lucide-react';
import { VersionDiffPanel } from '@/components/version-diff-panel';
import { useDoctorContext } from '../hooks/use-doctor-context';

/** Minimal shape of a consultation needed to populate the explicit picker (F6). */
interface ConsultationOption {
  id: string;
  patientId?: string;
  appointmentDate?: string;
}

function QualityBadge({ summary }: { summary: SummaryResponse }) {
  const cacheHit = summary.structuredData?.cacheHit;
  const qualityScore = summary.structuredData?.qualityScore;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {typeof cacheHit === 'boolean' && (
        <Badge variant={cacheHit ? 'secondary' : 'outline'} className="text-[10px]">
          {cacheHit ? 'cache hit' : 'cache miss'}
        </Badge>
      )}
      {typeof qualityScore === 'number' && (
        <Badge variant="outline" className="text-[10px] tabular-nums">
          quality {qualityScore.toFixed(2)}
        </Badge>
      )}
    </div>
  );
}

export function SavedSummariesPanel() {
  const { session } = useArca();
  const summaryApi = useArcaSummary();
  const { effectiveUserId, requiresImpersonation } = useDoctorContext();

  // F6: the consultation whose summaries we view is an EXPLICIT user choice,
  // not the implicit "last loaded wins" store consultation that the summary
  // page's suggestion loader mutates as a side effect.
  const [consultations, setConsultations] = useState<ConsultationOption[]>([]);
  const [loadingConsultations, setLoadingConsultations] = useState(false);
  const [selectedConsultationId, setSelectedConsultationId] = useState<string | null>(null);
  const consultationId = selectedConsultationId ?? session.consultation?.id ?? null;

  const [summaries, setSummaries] = useState<SummaryResponse[]>([]);
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [versions, setVersions] = useState<SummaryVersionEntry[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const [tags, setTags] = useState<SummaryTag[]>([]);
  const [newTagValue, setNewTagValue] = useState('');

  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const [fromVersion, setFromVersion] = useState<string>('');
  const [toVersion, setToVersion] = useState<string>('');
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffing, setDiffing] = useState(false);

  const selectedSummary = useMemo(() => summaries.find((s) => s.id === selectedId) ?? null, [summaries, selectedId]);

  const reloadSummaries = useCallback(async () => {
    if (!consultationId) {
      setSummaries([]);
      return;
    }
    setLoadingSummaries(true);
    try {
      // loadSummaries() reads the store's active consultation, so make sure the
      // store points at the explicitly selected one before fetching.
      if (session.consultation?.id !== consultationId) {
        await session.load(consultationId);
      }
      const list = await summaryApi.loadSummaries();
      setSummaries(list);
    } catch (err) {
      toast.error(`Failed to load summaries: ${(err as Error).message}`);
    } finally {
      setLoadingSummaries(false);
    }
  }, [consultationId, session, summaryApi]);

  // Populate the selector with the doctor's consultations and default the
  // selection (prefer the active store consultation, else the first listed).
  useEffect(() => {
    if (!effectiveUserId || requiresImpersonation) return;
    let cancelled = false;
    setLoadingConsultations(true);
    void (async () => {
      try {
        const res = await session.listConsultations({ doctorId: effectiveUserId, page: 1, limit: 20 });
        if (cancelled) return;
        const list = (res?.data ?? []) as ConsultationOption[];
        setConsultations(list);
        setSelectedConsultationId((prev) => prev ?? session.consultation?.id ?? list[0]?.id ?? null);
      } catch (err) {
        if (!cancelled) toast.error(`Failed to load consultations: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoadingConsultations(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on doctor identity
  }, [effectiveUserId, requiresImpersonation]);

  useEffect(() => {
    // Reset selection whenever the chosen consultation changes, then load.
    setSelectedId(null);
    setVersions([]);
    setTags([]);
    setDiff(null);
    void reloadSummaries();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is keyed on consultationId
  }, [consultationId]);

  const handleSelectConsultation = useCallback((id: string) => {
    setSelectedConsultationId(id);
  }, []);

  const selectSummary = useCallback(
    async (summary: SummaryResponse) => {
      setSelectedId(summary.id);
      setEditContent(summary.content);
      setDiff(null);
      setFromVersion('');
      setToVersion('');
      const contextItemId = summary.contextItemId ?? summary.id;
      setLoadingVersions(true);
      try {
        const [history, tagList] = await Promise.all([summaryApi.getSummaryHistory(contextItemId), summaryApi.getSummaryTags(contextItemId)]);
        setVersions(history);
        setTags(tagList);
      } catch (err) {
        toast.error(`Failed to load summary detail: ${(err as Error).message}`);
      } finally {
        setLoadingVersions(false);
      }
    },
    [summaryApi],
  );

  const handleSaveEdit = useCallback(async () => {
    if (!selectedSummary) return;
    if (!editContent.trim()) {
      toast.error('Summary content cannot be empty');
      return;
    }
    setSaving(true);
    try {
      await summaryApi.updateSummary(selectedSummary.id, editContent, { changeSource: 'doctor_edit', changeReason: 'Manual edit' });
      toast.success('Summary saved as a new version');
      await reloadSummaries();
      await selectSummary({ ...selectedSummary, content: editContent });
    } catch (err) {
      toast.error(`Failed to save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [selectedSummary, editContent, summaryApi, reloadSummaries, selectSummary]);

  const handleAddTag = useCallback(async () => {
    if (!selectedSummary || !newTagValue.trim()) return;
    const contextItemId = selectedSummary.contextItemId ?? selectedSummary.id;
    try {
      const created = await summaryApi.tagSummary(contextItemId, { tagValue: newTagValue.trim() });
      setTags((prev) => [...prev, created]);
      setNewTagValue('');
      toast.success('Tag added');
    } catch (err) {
      toast.error(`Failed to add tag: ${(err as Error).message}`);
    }
  }, [selectedSummary, newTagValue, summaryApi]);

  const handleRemoveTag = useCallback(
    async (tagId: string) => {
      if (!selectedSummary) return;
      const contextItemId = selectedSummary.contextItemId ?? selectedSummary.id;
      try {
        await summaryApi.deleteSummaryTag(contextItemId, tagId);
        setTags((prev) => prev.filter((t) => t.id !== tagId));
        toast.success('Tag removed');
      } catch (err) {
        toast.error(`Failed to remove tag: ${(err as Error).message}`);
      }
    },
    [selectedSummary, summaryApi],
  );

  const handleCompare = useCallback(async () => {
    if (!selectedSummary || !fromVersion || !toVersion) return;
    const contextItemId = selectedSummary.contextItemId ?? selectedSummary.id;
    setDiffing(true);
    try {
      const result = await summaryApi.diffSummaryVersions(contextItemId, Number(fromVersion), Number(toVersion));
      setDiff(result);
    } catch (err) {
      toast.error(`Failed to diff versions: ${(err as Error).message}`);
    } finally {
      setDiffing(false);
    }
  }, [selectedSummary, fromVersion, toVersion, summaryApi]);

  // ── No active consultation: informational empty state ──────────────
  if (!consultationId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4" /> Saved Summaries
          </CardTitle>
          <CardDescription>Manage persisted summaries, versions, diffs, and tags.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Sparkles className="text-muted-foreground/50 mb-3 size-10" />
            <p className="text-muted-foreground text-sm">Open a consultation (load context items above) to manage its saved summaries.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="saved-summaries-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4" /> Saved Summaries
          {summaries.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {summaries.length}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>List, version-browse, diff, tag, and edit a consultation's persisted summaries.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* F6: explicit consultation picker — decouples the viewed summaries
            from the implicit "last loaded" store consultation. */}
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-xs font-medium">Consultation</label>
          <Select value={consultationId ?? ''} onValueChange={handleSelectConsultation} disabled={loadingConsultations || consultations.length === 0}>
            <SelectTrigger className="w-full" data-testid="consultation-select">
              <SelectValue placeholder={loadingConsultations ? 'Loading consultations…' : 'Select a consultation'} />
            </SelectTrigger>
            <SelectContent>
              {consultations.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {(c.patientId ?? 'Unknown patient') + (c.appointmentDate ? ` · ${c.appointmentDate}` : '')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* List */}
        {loadingSummaries ? (
          <div className="space-y-2" data-testid="summaries-skeleton">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : summaries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center" data-testid="summaries-empty">
            <Sparkles className="text-muted-foreground/50 mb-3 size-10" />
            <p className="text-muted-foreground text-sm">No saved summaries for this consultation yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {summaries.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void selectSummary(s)}
                className={`hover:bg-muted/50 flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors ${
                  selectedId === s.id ? 'border-primary bg-muted/40' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={s.type === 'pre_summary' ? 'secondary' : 'default'} className="text-[10px]">
                      {s.type === 'pre_summary' ? 'Pre-Summary' : 'Summary'}
                    </Badge>
                    {typeof s.versionNumber === 'number' && <span className="text-muted-foreground text-xs">v{s.versionNumber}</span>}
                  </div>
                  <p className="mt-1 truncate text-sm">{s.content}</p>
                </div>
                <QualityBadge summary={s} />
              </button>
            ))}
          </div>
        )}

        {/* Detail for the selected summary */}
        {selectedSummary && (
          <>
            <Separator />

            {/* Tags */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <TagIcon className="size-3.5" /> Tags
              </h4>
              <div className="flex flex-wrap items-center gap-2">
                {tags.length === 0 && <span className="text-muted-foreground text-xs">No tags yet.</span>}
                {tags.map((t) => (
                  <Badge key={t.id} variant="outline" className="gap-1" style={t.color ? { borderColor: t.color } : undefined}>
                    {t.tagKey ? `${t.tagKey}: ${t.tagValue}` : t.tagValue}
                    <button type="button" aria-label={`Remove tag ${t.tagValue}`} onClick={() => void handleRemoveTag(t.id)}>
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <Input
                  value={newTagValue}
                  onChange={(e) => setNewTagValue(e.target.value)}
                  placeholder="Add a tag…"
                  className="h-8 max-w-xs"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleAddTag();
                    }
                  }}
                />
                <Button size="sm" variant="outline" onClick={() => void handleAddTag()} disabled={!newTagValue.trim()}>
                  <Plus className="mr-1 size-3.5" /> Add
                </Button>
              </div>
            </div>

            <Separator />

            {/* Edit → new version */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">Edit (creates a new version)</h4>
              <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={5} className="text-sm" />
              <div className="mt-2 flex justify-end">
                <Button size="sm" onClick={() => void handleSaveEdit()} disabled={saving || editContent === selectedSummary.content}>
                  {saving ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Save className="mr-1 size-3.5" />}
                  Save new version
                </Button>
              </div>
            </div>

            <Separator />

            {/* Version browser + diff */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <GitCompare className="size-3.5" /> Versions
              </h4>
              {loadingVersions ? (
                <div className="space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-2/3" />
                </div>
              ) : versions.length === 0 ? (
                <p className="text-muted-foreground text-xs">No prior versions — edit the summary to create one.</p>
              ) : (
                <>
                  <ul className="mb-3 space-y-1">
                    {versions.map((v) => (
                      <li key={v.id} className="text-muted-foreground text-xs">
                        <span className="text-foreground font-medium">v{v.versionNumber}</span>
                        {v.changeReason ? ` — ${v.changeReason}` : ''} ({new Date(v.createdAt).toLocaleString()})
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="text-muted-foreground mb-1 block text-xs">From</label>
                      <Select value={fromVersion} onValueChange={setFromVersion}>
                        <SelectTrigger className="h-8 w-24">
                          <SelectValue placeholder="v?" />
                        </SelectTrigger>
                        <SelectContent>
                          {versions.map((v) => (
                            <SelectItem key={v.id} value={String(v.versionNumber)}>
                              v{v.versionNumber}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-muted-foreground mb-1 block text-xs">To</label>
                      <Select value={toVersion} onValueChange={setToVersion}>
                        <SelectTrigger className="h-8 w-24">
                          <SelectValue placeholder="v?" />
                        </SelectTrigger>
                        <SelectContent>
                          {versions.map((v) => (
                            <SelectItem key={v.id} value={String(v.versionNumber)}>
                              v{v.versionNumber}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void handleCompare()} disabled={!fromVersion || !toVersion || diffing}>
                      {diffing ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <GitCompare className="mr-1 size-3.5" />}
                      Compare
                    </Button>
                  </div>

                  {diff && (
                    <div className="mt-3 rounded-md border">
                      <VersionDiffPanel
                        left={{ versionNumber: diff.from.versionNumber, date: diff.from.createdAt, changeReason: diff.from.changeReason }}
                        right={{ versionNumber: diff.to.versionNumber, date: diff.to.createdAt, changeReason: diff.to.changeReason }}
                        sections={[{ label: 'Content', oldText: diff.from.content, newText: diff.to.content }]}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
