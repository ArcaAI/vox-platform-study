import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { useTenants, type Tenant } from '@arcaai/vox';
import { Plus, X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { addTag, removeTag, tagsChanged } from '@/features/tenants/tenant-tags';

/**
 * Tenant tags editor (TASK-387 #2 / F9). Loads the current set via
 * `useTenants().getTags` on open, edits a local draft (add / remove chips), and
 * replaces the whole set via `setTags`. The server returns the updated tenant,
 * bubbled up through `onSaved`.
 */
export function TenantTagsDialog({
  open,
  onOpenChange,
  tenant,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: Tenant;
  onSaved: (updated: Tenant) => void;
}) {
  const { getTags, setTags } = useTenants();
  const [draft, setDraft] = useState<string[]>([]);
  const [entry, setEntry] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [baseline, setBaseline] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    // Seed immediately from the tenant DTO, then reconcile with the authoritative GET.
    const seed = Array.isArray(tenant.tags) ? tenant.tags : [];
    setDraft(seed);
    setBaseline(seed);
    setEntry('');
    setLoading(true);
    getTags(tenant.id)
      .then((tags) => {
        setDraft(tags);
        setBaseline(tags);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [open, tenant.id, tenant.tags, getTags]);

  const commitEntry = () => {
    const next = addTag(draft, entry);
    setDraft(next);
    setEntry('');
  };

  const onEntryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitEntry();
    }
  };

  const dirty = tagsChanged(draft, baseline);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const updated = await setTags(tenant.id, draft);
      toast.success('Tags updated');
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update tags');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>Free-form labels for {tenant.name}. Used to group and filter tenants.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tenant-tag-entry">Add a tag</Label>
            <div className="flex items-center gap-2">
              <Input
                id="tenant-tag-entry"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={onEntryKeyDown}
                placeholder="e.g. pilot, priority…"
                autoFocus
              />
              <Button type="button" variant="outline" onClick={commitEntry} disabled={!entry.trim()}>
                <Plus className="size-4" />
                Add
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Press Enter or comma to add.</p>
          </div>

          <div className="flex min-h-16 flex-wrap content-start items-start gap-1.5 rounded-md border border-input p-2.5">
            {draft.length === 0 ? (
              <p className="text-sm text-muted-foreground">{loading ? 'Loading tags…' : 'No tags yet.'}</p>
            ) : (
              draft.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                  <span className="truncate">{tag}</span>
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => removeTag(prev, tag))}
                    aria-label={`Remove ${tag}`}
                    className="rounded-full p-0.5 hover:bg-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>
        </div>
        <DialogFooter className={MOBILE_DIALOG_FOOTER}>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void handleSave()} disabled={!dirty || isSaving}>
            {isSaving ? <Spinner className="size-4" /> : 'Save tags'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
