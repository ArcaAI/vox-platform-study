import { useEffect, useState } from 'react';

import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Textarea } from '@arcaai/ui/textarea';
import { Loader2, Save } from 'lucide-react';

import type { AvailablePrompt, PromptTemplateCategory } from '../api/prompts';

const CATEGORIES: PromptTemplateCategory[] = ['SUMMARY', 'DNA_ANALYSIS', 'SYSTEM', 'CUSTOM'];

export interface PromptFormValues {
  name: string;
  category: PromptTemplateCategory;
  content: string;
  description?: string;
  changeReason?: string;
}

interface PromptFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  initial?: AvailablePrompt | null;
  pending?: boolean;
  onSubmit: (values: PromptFormValues) => void;
}

/**
 * TASK-356 Phase 6 (S7) — create/edit dialog for a doctor's PERSONAL prompt.
 *
 * Create captures name + category + content; edit locks name/category (identity)
 * and edits content/description with an optional change reason (the version-row
 * `changeReason`). Mirrors the admin prompt form but own-scoped and minimal.
 */
export function PromptFormDialog({ open, onOpenChange, mode, initial, pending, onSubmit }: PromptFormDialogProps) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<PromptTemplateCategory>('SUMMARY');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [changeReason, setChangeReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setCategory((initial?.category as PromptTemplateCategory) ?? 'SUMMARY');
    setContent(initial?.content ?? '');
    setDescription(initial?.description ?? '');
    setChangeReason('');
  }, [open, initial]);

  const isEdit = mode === 'edit';
  const canSubmit = content.trim().length > 0 && (isEdit || name.trim().length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      category,
      content,
      description: description.trim() || undefined,
      changeReason: changeReason.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit personal prompt' : 'Create personal prompt'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the content of your personal prompt. A new version is recorded on save.'
              : 'Create a prompt owned by you. Only you can use, edit, or delete it.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="prompt-name">Name</Label>
            <Input
              id="prompt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My SOAP summary prompt"
              disabled={isEdit || pending}
              required={!isEdit}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="prompt-category">Category</Label>
            <select
              id="prompt-category"
              className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              value={category}
              onChange={(e) => setCategory(e.target.value as PromptTemplateCategory)}
              disabled={isEdit || pending}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="prompt-description">Description</Label>
            <Input
              id="prompt-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — what this prompt is for"
              disabled={pending}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="prompt-content">Content</Label>
            <Textarea
              id="prompt-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="You are a clinical assistant…"
              className="min-h-48 font-mono text-sm"
              disabled={pending}
              required
            />
          </div>

          {isEdit && (
            <div className="grid gap-2">
              <Label htmlFor="prompt-change-reason">Change reason</Label>
              <Input
                id="prompt-change-reason"
                value={changeReason}
                onChange={(e) => setChangeReason(e.target.value)}
                placeholder="Optional — why you changed it"
                disabled={pending}
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || pending}>
              {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
              {isEdit ? 'Save changes' : 'Create prompt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
