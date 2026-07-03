import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import type { Policy } from '@arcaai/vox';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { PolicyRulesEditor, type PolicyRulesMode } from './policy-rules-editor';
import {
  draftsToRules,
  emptyRuleDraft,
  isBuilderRepresentable,
  parseRulesText,
  rulesToDrafts,
  serializeRules,
  type PolicyRuleDraft,
} from './policy-rules';

export interface PolicyInput {
  name: string;
  description?: string;
  scope?: string;
  rules: unknown[];
  // SDK `CreatePolicyInput`/`UpdatePolicyInput` carry an `[key: string]: unknown`
  // index signature; mirroring it keeps this input directly assignable to the
  // SDK `usePolicies()` create/update/validate methods.
  [key: string]: unknown;
}

type Feedback = { kind: 'error' | 'success'; text: string } | null;

/**
 * Create/edit policy dialog (TASK-374). The CASL rules are edited with the
 * visual {@link PolicyRulesEditor} (Builder tab) and a validated-JSON "Advanced"
 * fallback; both paths reach the server `validate()` and the create/update save.
 * `update`/`create` are SDK `usePolicies()` methods (no raw apiClient needed).
 */
export function PolicyFormDialog({
  mode,
  initial,
  open,
  onOpenChange,
  trigger,
  onSave,
  onValidate,
}: {
  mode: 'create' | 'edit';
  initial?: Policy | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  onSave: (input: PolicyInput) => Promise<void>;
  onValidate: (input: PolicyInput) => Promise<{ valid: boolean; errors?: string[] }>;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [description, setDescription] = useState('');
  const [rulesMode, setRulesMode] = useState<PolicyRulesMode>('builder');
  const [drafts, setDrafts] = useState<PolicyRuleDraft[]>([emptyRuleDraft()]);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSaving(false);
    setValidating(false);
    setFeedback(null);
    setJsonError(null);
    setName(initial?.name ?? '');
    setScope(initial?.scope ?? '');
    setDescription(initial?.description ?? '');

    const existing = Array.isArray(initial?.rules) ? (initial?.rules as unknown[]) : [];
    if (mode === 'edit' && existing.length > 0) {
      if (isBuilderRepresentable(existing)) {
        const nextDrafts = rulesToDrafts(existing);
        setDrafts(nextDrafts);
        setJsonText(serializeRules(nextDrafts));
        setRulesMode('builder');
      } else {
        // Advanced rules (array actions / nested conditions / extra keys) →
        // open the JSON fallback so nothing is lost.
        setDrafts([emptyRuleDraft()]);
        setJsonText(JSON.stringify(existing, null, 2));
        setRulesMode('json');
      }
    } else {
      const initialDrafts = [emptyRuleDraft()];
      setDrafts(initialDrafts);
      setJsonText(serializeRules(initialDrafts));
      setRulesMode('builder');
    }
  }, [isOpen, mode, initial]);

  const handleModeChange = (next: PolicyRulesMode) => {
    if (next === rulesMode) return;
    if (next === 'json') {
      setJsonText(serializeRules(drafts));
      setJsonError(null);
      setRulesMode('json');
      return;
    }
    const parsed = parseRulesText(jsonText);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return; // stay on JSON until it parses
    }
    if (isBuilderRepresentable(parsed.rules)) {
      setDrafts(rulesToDrafts(parsed.rules));
      setJsonError(null);
      setRulesMode('builder');
    } else {
      setJsonError('These rules use advanced features (array actions, nested conditions, or extra keys). Keep editing them as JSON.');
    }
  };

  const handleJsonTextChange = (text: string) => {
    setJsonText(text);
    const parsed = parseRulesText(text);
    setJsonError(parsed.ok ? null : parsed.error);
  };

  const currentRules = (): { ok: true; rules: unknown[] } | { ok: false; error: string } => {
    if (rulesMode === 'json') return parseRulesText(jsonText);
    return { ok: true, rules: draftsToRules(drafts) };
  };

  const buildInput = (): PolicyInput | null => {
    if (!name.trim()) {
      setFeedback({ kind: 'error', text: 'Name is required.' });
      return null;
    }
    const rules = currentRules();
    if (!rules.ok) {
      setFeedback({ kind: 'error', text: rules.error });
      return null;
    }
    return { name: name.trim(), description: description.trim() || undefined, scope: scope.trim() || undefined, rules: rules.rules };
  };

  const onValidateClick = async () => {
    const input = buildInput();
    if (!input) return;
    setValidating(true);
    try {
      const result = await onValidate(input);
      setFeedback(
        result.valid ? { kind: 'success', text: 'Rules are valid.' } : { kind: 'error', text: result.errors?.join('; ') || 'Rules are invalid.' },
      );
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : 'Validation failed.' });
    } finally {
      setValidating(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = buildInput();
    if (!input) return;
    setSaving(true);
    try {
      await onSave(input);
      setOpen(false);
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : `Failed to ${mode === 'create' ? 'create' : 'update'} policy.` });
    } finally {
      setSaving(false);
    }
  };

  const saveDisabled = !name.trim() || saving || (rulesMode === 'json' && Boolean(jsonError));

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className={cn('flex h-[80vh] flex-col gap-0 sm:max-w-[70vw]', MOBILE_DIALOG_CONTENT)}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>{mode === 'create' ? 'New policy' : `Edit policy`}</DialogTitle>
            <DialogDescription>
              Policies hold CASL ability rules. Build them visually or edit the JSON directly, then validate against the server before saving.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="policy-name">Name</Label>
                <Input id="policy-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="policy-scope">Scope</Label>
                <Input id="policy-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. tenant" />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-desc">Description</Label>
              <Input id="policy-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <PolicyRulesEditor
              mode={rulesMode}
              onModeChange={handleModeChange}
              drafts={drafts}
              onDraftsChange={setDrafts}
              jsonText={jsonText}
              onJsonTextChange={handleJsonTextChange}
              jsonError={jsonError}
            />

            {feedback ? (
              <Alert variant={feedback.kind === 'error' ? 'destructive' : 'default'}>
                {feedback.kind === 'error' ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
                <AlertTitle>{feedback.kind === 'error' ? 'Invalid' : 'Valid'}</AlertTitle>
                <AlertDescription>{feedback.text}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter className={cn('shrink-0', MOBILE_DIALOG_FOOTER)}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="outline" onClick={() => void onValidateClick()} disabled={validating || saving}>
              {validating ? <Spinner className="size-4" /> : 'Validate'}
            </Button>
            <Button type="submit" disabled={saveDisabled}>
              {saving ? <Spinner className="size-4" /> : mode === 'create' ? 'Create policy' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
