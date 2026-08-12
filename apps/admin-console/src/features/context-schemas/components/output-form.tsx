'use client';

/**
 * Output-kind editor (TASK-666 scope: "what the loop may emit back"). A
 * narrower sibling of `KindForm` — outputs carry no `phiClass`/`cardinality`/
 * `lifecycle`/`producedBy`/`required`/`constraints`/`deprecated`, matching the
 * server's `OUTPUT_KEYS` allow-list (`context-schema-definition.ts`).
 */

import { useId } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { CodeEditor } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { authorableJsonSchemaProblems } from '../lib/json-schema-subset';
import { CONTEXT_PRIMITIVES, type ContextOutputDeclaration, type ContextPrimitive } from '../api/types';

export function OutputForm({
  output,
  onChange,
  onRemove,
}: {
  output: ContextOutputDeclaration;
  onChange: (next: ContextOutputDeclaration) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const fieldsText = JSON.stringify(output.fields ?? {}, null, 2);
  const fieldsProblems = output.fields !== undefined ? authorableJsonSchemaProblems(output.fields) : [];

  function patch(next: Partial<ContextOutputDeclaration>) {
    onChange({ ...output, ...next });
  }

  function handleFieldsChange(text: string) {
    try {
      patch({ fields: JSON.parse(text) as Record<string, unknown> });
    } catch {
      // Invalid JSON mid-edit — the CodeEditor toolbar already flags it.
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-key`}>
            Key <span aria-hidden className="text-destructive">*</span>
          </Label>
          <Input id={`${uid}-key`} value={output.key} onChange={(event) => patch({ key: event.target.value })} placeholder="soap_note" className="font-mono" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-label`}>Label</Label>
          <Input id={`${uid}-label`} value={output.label ?? ''} onChange={(event) => patch({ label: event.target.value || undefined })} placeholder="SOAP Note" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-primitive`}>
          Primitive <span aria-hidden className="text-destructive">*</span>
        </Label>
        {/* Same closed set/enforcement as the kind editor — an output cannot name a sixth primitive either. */}
        <Select value={output.primitive} onValueChange={(next) => patch({ primitive: next as ContextPrimitive })}>
          <SelectTrigger id={`${uid}-primitive`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTEXT_PRIMITIVES.map((primitive) => (
              <SelectItem key={primitive} value={primitive}>
                {primitive}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea id={`${uid}-description`} value={output.description ?? ''} onChange={(event) => patch({ description: event.target.value || undefined })} rows={2} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-fields`}>Fields (JSON Schema, optional)</Label>
        <CodeEditor aria-label="Output fields JSON Schema" value={fieldsText} onChange={handleFieldsChange} language="json" className="min-h-32" />
        {fieldsProblems.length > 0 ? (
          <ul className="text-destructive flex flex-col gap-0.5 text-xs">
            {fieldsProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          <IconTrash aria-hidden />
          Remove output
        </Button>
      </div>
    </div>
  );
}
