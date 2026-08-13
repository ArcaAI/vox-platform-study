'use client';

/**
 * Sample-payload tester — validates a hand-authored JSON
 * payload against a STRUCTURED kind's `fields` from the CURRENT DRAFT (the
 * same `definition` state the Definition tab is editing, not the last
 * published version), using the shared, dependency-free evaluator
 * (`@arcaai/json-schema-subset`) — the SAME code the server enforces with,
 * rather than a copy of it. This is still only a local preview: the real
 * enforcement happens server-side, in `ConsultationContextSchemaService
 * #validateContextPayload`, the moment a client actually writes a context
 * item of this kind. Sharing the implementation means the preview can no
 * longer disagree with that gate.
 */

import { useMemo, useState } from 'react';
import { IconCircleCheck, IconFlask } from '@tabler/icons-react';
import { CodeEditor, validateJson } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { EmptyState } from '@/shared/state/empty-state';
import type { ContextSchemaDefinition } from '../api/types';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';

export function PayloadTester({ definition }: { definition: ContextSchemaDefinition }) {
  const structuredKinds = useMemo(() => definition.kinds.filter((kind) => kind.primitive === 'STRUCTURED' && kind.key), [definition.kinds]);
  const [pickedKindKey, setKindKey] = useState('');
  const [payloadText, setPayloadText] = useState('{}');
  const [result, setResult] = useState<string[] | null>(null);

  // Self-heals against a stale/empty selection: this tab mounts alongside
  // every other tab (Radix keeps inactive `TabsContent` in the DOM), so on
  // first render `definition` is still the pre-load empty draft — the picked
  // kind must fall forward to whatever `structuredKinds` resolves to once the
  // draft is seeded, not freeze on the mount-time value.
  const kindKey = structuredKinds.some((entry) => entry.key === pickedKindKey) ? pickedKindKey : (structuredKinds[0]?.key ?? '');
  const kind = structuredKinds.find((entry) => entry.key === kindKey);

  function handleValidate() {
    if (!kind) return;
    const parsed = validateJson(payloadText);
    if (!parsed.ok) {
      setResult([`Payload is not valid JSON${parsed.line !== undefined ? ` (line ${parsed.line}, column ${parsed.column})` : ''}.`]);
      return;
    }
    const payload = JSON.parse(payloadText) as unknown;
    setResult(jsonSchemaValueProblems(kind.fields ?? {}, payload));
  }

  if (structuredKinds.length === 0) {
    return (
      <EmptyState
        icon={IconFlask}
        title="No STRUCTURED kinds to test"
        description="Add a kind with primitive STRUCTURED in the Definition tab to try a sample payload against its fields."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="payload-tester-kind">Kind</Label>
        <Select
          value={kindKey}
          onValueChange={(next) => {
            setKindKey(next);
            setResult(null);
          }}
        >
          <SelectTrigger id="payload-tester-kind" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {structuredKinds.map((entry) => (
              <SelectItem key={entry.key} value={entry.key}>
                {entry.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="payload-tester-editor">Sample payload</Label>
        <CodeEditor
          aria-label="Sample payload"
          value={payloadText}
          onChange={(next) => {
            setPayloadText(next);
            setResult(null);
          }}
          language="json"
          className="min-h-48"
        />
      </div>

      <div className="flex justify-end">
        <Button type="button" onClick={handleValidate} disabled={!kind}>
          <IconFlask aria-hidden />
          Validate
        </Button>
      </div>

      {result !== null ? (
        result.length === 0 ? (
          <div className="text-success flex items-center gap-2 text-sm" role="status">
            <IconCircleCheck aria-hidden className="size-4" />
            Payload conforms to &lsquo;{kindKey}&rsquo;.
          </div>
        ) : (
          <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm">
            <p className="text-destructive mb-1 font-medium">Payload does not conform:</p>
            <ul className="text-destructive flex flex-col gap-0.5">
              {result.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      <p className="text-muted-foreground text-xs">
        Local preview against the current draft only — the server re-validates every payload at write time against the tenant&apos;s PINNED version.
      </p>
    </div>
  );
}
