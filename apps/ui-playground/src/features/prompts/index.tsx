import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@arcaai/ui/alert-dialog';
import { Skeleton } from '@arcaai/ui/skeleton';
import { FileText, GitCompare, Pencil, Plus, Star, StarOff, Trash2 } from 'lucide-react';

import { Main } from '@/components/layout/main';
import { ImpersonationGuard } from '@/components/impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';

import {
  useAvailablePrompts,
  useCreatePersonalPrompt,
  useDeletePersonalPrompt,
  useSetPreferredPrompt,
  useUpdatePersonalPrompt,
  type AvailablePrompt,
} from './api/prompts';
import { findCategoryDefault, partitionAvailablePrompts } from './lib/partition';
import { DraftFinalDiffViewer } from './components/draft-final-diff-viewer';
import { PromptFormDialog, type PromptFormValues } from './components/prompt-form-dialog';

function PreferredBadge() {
  return (
    <Badge variant="default" className="gap-1">
      <Star className="size-3" aria-hidden="true" />
      Preferred
    </Badge>
  );
}

export default function MyPromptsPage() {
  const { requiresImpersonation } = useDoctorContext();

  const { data: available = [], isLoading } = useAvailablePrompts(undefined, { enabled: !requiresImpersonation });
  const createMutation = useCreatePersonalPrompt();
  const updateMutation = useUpdatePersonalPrompt();
  const deleteMutation = useDeletePersonalPrompt();
  const setPreferredMutation = useSetPreferredPrompt();

  // The available list doesn't carry the caller's preferred id, so track it
  // locally from set-preferred results (playground UX). `undefined` = unknown.
  const [preferredId, setPreferredId] = useState<string | null | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AvailablePrompt | null>(null);
  const [deleting, setDeleting] = useState<AvailablePrompt | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);

  const { personal, defaults } = useMemo(() => partitionAvailablePrompts(available), [available]);

  const handleCreate = useCallback(
    (values: PromptFormValues) => {
      createMutation.mutate(
        { name: values.name, category: values.category, content: values.content, description: values.description },
        {
          onSuccess: () => {
            toast.success('Personal prompt created');
            setCreateOpen(false);
          },
          onError: (err) => toast.error(`Failed to create prompt: ${err.message}`),
        },
      );
    },
    [createMutation],
  );

  const handleEdit = useCallback(
    (values: PromptFormValues) => {
      if (!editing) return;
      updateMutation.mutate(
        {
          id: editing.id,
          content: values.content,
          description: values.description,
          changeReason: values.changeReason,
          expectedVersion: editing.version ?? 0,
        },
        {
          onSuccess: () => {
            toast.success('Personal prompt updated');
            setEditing(null);
          },
          onError: (err) => toast.error(`Failed to update prompt: ${err.message}`),
        },
      );
    },
    [editing, updateMutation],
  );

  const handleDelete = useCallback(() => {
    if (!deleting) return;
    const id = deleting.id;
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toast.success('Personal prompt deleted');
        if (preferredId === id) setPreferredId(null);
        if (compareId === id) setCompareId(null);
        setDeleting(null);
      },
      onError: (err) => toast.error(`Failed to delete prompt: ${err.message}`),
    });
  }, [deleting, deleteMutation, preferredId, compareId]);

  const handleSetPreferred = useCallback(
    (id: string | null) => {
      setPreferredMutation.mutate(id, {
        onSuccess: (data) => {
          setPreferredId(data.preferredPromptTemplateId);
          toast.success(id ? 'Preferred prompt updated' : 'Preferred prompt cleared');
        },
        onError: (err) => toast.error(`Failed to update preferred prompt: ${err.message}`),
      });
    },
    [setPreferredMutation],
  );

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mb-6 flex items-start justify-between" data-doc="prompts-header">
            <div>
              <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
                <FileText className="size-6" />
                My Prompts
              </h2>
              <p className="text-muted-foreground mt-1">
                Author your own prompt templates and pick the one used by default for your documentation.
              </p>
            </div>
            {!requiresImpersonation && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 size-4" />
                Create personal prompt
              </Button>
            )}
          </div>

          <ImpersonationGuard featureName="My Prompts">
            {isLoading ? (
              <div className="grid gap-4 md:grid-cols-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-40 rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="space-y-8">
                {/* Personal prompts */}
                <section data-doc="my-personal-prompts">
                  <h3 className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">My personal prompts</h3>
                  {personal.length === 0 ? (
                    <Card className="border-dashed">
                      <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                        <FileText className="text-muted-foreground/50 mb-2 size-8" aria-hidden="true" />
                        <p className="text-muted-foreground text-sm">You have no personal prompts yet. Create one to get started.</p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {personal.map((p) => {
                        const categoryDefault = findCategoryDefault(p, available);
                        const isComparing = compareId === p.id;
                        return (
                          <Card key={p.id} data-testid="personal-prompt-card">
                            <CardHeader className="pb-3">
                              <div className="flex items-start justify-between gap-2">
                                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                                  {p.name}
                                  <Badge variant="outline">{p.category}</Badge>
                                  {preferredId === p.id && <PreferredBadge />}
                                </CardTitle>
                              </div>
                              {p.description && <CardDescription>{p.description}</CardDescription>}
                            </CardHeader>
                            <CardContent className="space-y-3">
                              <p className="text-muted-foreground line-clamp-2 font-mono text-xs">{p.content}</p>
                              <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                                  <Pencil className="mr-1.5 size-3.5" />
                                  Edit
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setDeleting(p)}>
                                  <Trash2 className="mr-1.5 size-3.5" />
                                  Delete
                                </Button>
                                {preferredId === p.id ? (
                                  <Button variant="ghost" size="sm" onClick={() => handleSetPreferred(null)} disabled={setPreferredMutation.isPending}>
                                    <StarOff className="mr-1.5 size-3.5" />
                                    Clear preferred
                                  </Button>
                                ) : (
                                  <Button variant="ghost" size="sm" onClick={() => handleSetPreferred(p.id)} disabled={setPreferredMutation.isPending}>
                                    <Star className="mr-1.5 size-3.5" />
                                    Set as preferred
                                  </Button>
                                )}
                                {categoryDefault && (
                                  <Button variant="ghost" size="sm" onClick={() => setCompareId(isComparing ? null : p.id)}>
                                    <GitCompare className="mr-1.5 size-3.5" />
                                    {isComparing ? 'Hide diff' : 'Compare to default'}
                                  </Button>
                                )}
                              </div>
                              {isComparing && categoryDefault && (
                                <DraftFinalDiffViewer
                                  draftText={categoryDefault.content}
                                  finalText={p.content}
                                  draftLabel={`Default · ${categoryDefault.name}`}
                                  finalLabel={`Yours · ${p.name}`}
                                  title="Default → Your version"
                                  description="How your personal prompt differs from the category default (read-only)."
                                />
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Available defaults */}
                <section data-doc="available-default-prompts">
                  <h3 className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">Available defaults</h3>
                  {defaults.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No shared default prompts are available.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {defaults.map((p) => (
                        <Card key={p.id} data-testid="default-prompt-card">
                          <CardHeader className="pb-3">
                            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                              {p.name}
                              <Badge variant="outline">{p.category}</Badge>
                              {preferredId === p.id && <PreferredBadge />}
                            </CardTitle>
                            {p.description && <CardDescription>{p.description}</CardDescription>}
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <p className="text-muted-foreground line-clamp-2 font-mono text-xs">{p.content}</p>
                            {preferredId === p.id ? (
                              <Button variant="ghost" size="sm" onClick={() => handleSetPreferred(null)} disabled={setPreferredMutation.isPending}>
                                <StarOff className="mr-1.5 size-3.5" />
                                Clear preferred
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => handleSetPreferred(p.id)} disabled={setPreferredMutation.isPending}>
                                <Star className="mr-1.5 size-3.5" />
                                Set as preferred
                              </Button>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </ImpersonationGuard>

          {/* Dialogs (gated like the trigger — defense-in-depth) */}
          {!requiresImpersonation && (
            <PromptFormDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              mode="create"
              pending={createMutation.isPending}
              onSubmit={handleCreate}
            />
          )}

          <PromptFormDialog
            open={!!editing}
            onOpenChange={(v) => {
              if (!v) setEditing(null);
            }}
            mode="edit"
            initial={editing}
            pending={updateMutation.isPending}
            onSubmit={handleEdit}
          />

          <AlertDialog
            open={!!deleting}
            onOpenChange={(v) => {
              if (!v) setDeleting(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete personal prompt?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove “{deleting?.name}”. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} disabled={deleteMutation.isPending}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </Main>
  );
}
