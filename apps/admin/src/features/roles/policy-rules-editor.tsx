import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Switch } from '@arcaai/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { AlertTriangle, Plus, Trash2, X } from 'lucide-react';
import { POLICY_ACTIONS, POLICY_CONDITION_VARIABLES, POLICY_SUBJECTS, emptyRuleDraft, type PolicyRuleDraft } from './policy-rules';

const CONDITION_VARS_LIST_ID = 'policy-condition-vars';

export type PolicyRulesMode = 'builder' | 'json';

export interface PolicyRulesEditorProps {
  mode: PolicyRulesMode;
  onModeChange: (mode: PolicyRulesMode) => void;
  drafts: PolicyRuleDraft[];
  onDraftsChange: (drafts: PolicyRuleDraft[]) => void;
  jsonText: string;
  onJsonTextChange: (text: string) => void;
  jsonError: string | null;
}

/**
 * Visual CASL rule-builder (TASK-374) with an "Advanced (JSON)" fallback tab.
 * Presentational/controlled: the parent owns the canonical state (drafts + JSON
 * text) and the mode-switch / validate / save logic; this component only renders
 * the structured editor and the textarea. Grounded in
 * `knowledge/04_ACCESS_CONTROL.md` (actions / subjects / condition variables).
 */
export function PolicyRulesEditor({ mode, onModeChange, drafts, onDraftsChange, jsonText, onJsonTextChange, jsonError }: PolicyRulesEditorProps) {
  const updateDraft = (index: number, patch: Partial<PolicyRuleDraft>) => {
    onDraftsChange(drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };
  const removeDraft = (index: number) => onDraftsChange(drafts.filter((_, i) => i !== index));
  const addDraft = () => onDraftsChange([...drafts, emptyRuleDraft()]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <datalist id={CONDITION_VARS_LIST_ID}>
        {POLICY_CONDITION_VARIABLES.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>

      <Tabs value={mode} onValueChange={(v) => onModeChange(v as PolicyRulesMode)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="self-start">
          <TabsTrigger value="builder">Builder</TabsTrigger>
          <TabsTrigger value="json">Advanced (JSON)</TabsTrigger>
        </TabsList>

        <TabsContent value="builder" className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {drafts.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No rules yet. Add a rule to grant or deny an action on a subject.
              </p>
            ) : (
              drafts.map((draft, index) => (
                <RuleRow
                  key={index}
                  index={index}
                  draft={draft}
                  onChange={(patch) => updateDraft(index, patch)}
                  onRemove={() => removeDraft(index)}
                  canRemove={drafts.length > 1}
                />
              ))
            )}
          </div>
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={addDraft}>
            <Plus className="size-4" />
            Add rule
          </Button>
        </TabsContent>

        <TabsContent value="json" className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
          <Label htmlFor="policy-rules-json">CASL rules (JSON)</Label>
          <Textarea
            id="policy-rules-json"
            value={jsonText}
            onChange={(e) => onJsonTextChange(e.target.value)}
            rows={12}
            spellCheck={false}
            className="min-h-48 flex-1 font-mono text-xs"
            aria-invalid={Boolean(jsonError)}
          />
          <p className="text-xs text-muted-foreground">Array of {`{ action, subject, conditions?, fields?, inverted?, reason? }`} objects.</p>
          {jsonError ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Invalid JSON</AlertTitle>
              <AlertDescription>{jsonError}</AlertDescription>
            </Alert>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RuleRow({
  index,
  draft,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  draft: PolicyRuleDraft;
  onChange: (patch: Partial<PolicyRuleDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  // Surface a custom (non-vocabulary) subject loaded from an existing policy.
  const subjectOptions = (POLICY_SUBJECTS as readonly string[]).includes(draft.subject) ? POLICY_SUBJECTS : [draft.subject, ...POLICY_SUBJECTS];

  const updateCondition = (ci: number, patch: Partial<{ key: string; value: string }>) => {
    onChange({ conditions: draft.conditions.map((c, i) => (i === ci ? { ...c, ...patch } : c)) });
  };
  const addCondition = () => onChange({ conditions: [...draft.conditions, { key: '', value: '' }] });
  const removeCondition = (ci: number) => onChange({ conditions: draft.conditions.filter((_, i) => i !== ci) });

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`rule-${index}-action`} className="text-xs text-muted-foreground">
            Action
          </Label>
          <Select value={draft.action} onValueChange={(v) => onChange({ action: v })}>
            <SelectTrigger id={`rule-${index}-action`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLICY_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`rule-${index}-subject`} className="text-xs text-muted-foreground">
            Subject
          </Label>
          <Select value={draft.subject} onValueChange={(v) => onChange({ subject: v })}>
            <SelectTrigger id={`rule-${index}-subject`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {subjectOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove rule ${index + 1}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Conditions</span>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addCondition}>
            <Plus className="size-3.5" />
            Add condition
          </Button>
        </div>
        {draft.conditions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No conditions — the rule applies to all records of the subject.</p>
        ) : (
          draft.conditions.map((cond, ci) => (
            <div key={ci} className="flex items-center gap-2">
              <Input
                aria-label={`Rule ${index + 1} condition ${ci + 1} field`}
                value={cond.key}
                onChange={(e) => updateCondition(ci, { key: e.target.value })}
                placeholder="field (e.g. tenantId)"
                className="h-8 flex-1 text-xs"
              />
              <span className="text-xs text-muted-foreground">=</span>
              <Input
                aria-label={`Rule ${index + 1} condition ${ci + 1} value`}
                value={cond.value}
                onChange={(e) => updateCondition(ci, { value: e.target.value })}
                placeholder="${context.tenantId}"
                list={CONDITION_VARS_LIST_ID}
                className="h-8 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeCondition(ci)}
                aria-label={`Remove condition ${ci + 1} from rule ${index + 1}`}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`rule-${index}-fields`} className="text-xs text-muted-foreground">
          Fields <span className="font-normal">(optional, comma-separated — restricts which fields are accessible)</span>
        </Label>
        <Input
          id={`rule-${index}-fields`}
          value={draft.fields}
          onChange={(e) => onChange({ fields: e.target.value })}
          placeholder="e.g. id, email, displayName"
          className="h-8 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch id={`rule-${index}-inverted`} checked={draft.inverted} onCheckedChange={(checked) => onChange({ inverted: checked })} />
          <Label htmlFor={`rule-${index}-inverted`} className="text-xs">
            Deny (inverted rule)
          </Label>
        </div>
        {draft.inverted ? (
          <Input
            aria-label={`Rule ${index + 1} denial reason`}
            value={draft.reason}
            onChange={(e) => onChange({ reason: e.target.value })}
            placeholder="Reason (optional, e.g. Users are archived, not deleted)"
            className="h-8 min-w-48 flex-1 text-xs"
          />
        ) : null}
      </div>
    </div>
  );
}
