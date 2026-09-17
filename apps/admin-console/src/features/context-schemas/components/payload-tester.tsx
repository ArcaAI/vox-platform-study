'use client';

/**
 * "Try a sample payload" — validates a hand-authored JSON payload against ONE
 * STRUCTURED kind's `fields`, using the shared, dependency-free evaluator
 * (`@arcaai/json-schema-subset`) — the SAME code the server enforces with,
 * rather than a copy of it. This is still only a local preview: the real
 * enforcement happens server-side, in
 * `ConsultationContextSchemaService#validateContextPayload`, the moment a client
 * actually writes a context item of this kind. Sharing the implementation means
 * the preview can no longer disagree with that gate.
 *
 * It lives beside the kind it tests rather than in a tab of its own. A tab
 * forced an admin to pick the kind a second time, from a dropdown listing kinds
 * they had just been editing; here the kind is already chosen by where the
 * button is, and the modal validates against the CURRENT draft of exactly that
 * kind.
 */

import { useState } from 'react';
import { IconCircleCheck, IconFlask } from '@tabler/icons-react';
import { CodeEditor, validateJson } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import type { ContextKindDeclaration } from '../api/types';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

export function KindPayloadTester({ kind }: { kind: ContextKindDeclaration }) {
  const [open, setOpen] = useState(false);
  const [payloadText, setPayloadText] = useState('{}');
  const [result, setResult] = useState<string[] | null>(null);

  function handleValidate() {
    const parsed = validateJson(payloadText);
    if (!parsed.ok) {
      setResult([`Payload is not valid JSON${parsed.line !== undefined ? ` (line ${parsed.line}, column ${parsed.column})` : ''}.`]);
      return;
    }
    setResult(jsonSchemaValueProblems(kind.fields ?? {}, JSON.parse(payloadText) as unknown));
  }

  if (kind.primitive !== 'STRUCTURED') return null;

  const kindName = kind.key || kind.label || 'this kind';

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <IconFlask aria-hidden />
        Try a sample payload
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setResult(null);
        }}
      >
        <DialogContent className={DIALOG_SIZE_CLASS.lg}>
          <DialogHeader>
            <DialogTitle>Try a sample payload against &lsquo;{kindName}&rsquo;</DialogTitle>
            <DialogDescription>
              Checked against the current draft of this kind. The server re-validates every payload at write time against the tenant&apos;s PINNED
              version.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <Label htmlFor="payload-tester-editor">Sample payload</Label>
            <CodeEditor
              aria-label="Sample payload"
              value={payloadText}
              onChange={(next) => {
                setPayloadText(next);
                setResult(null);
              }}
              language="json"
              className="min-h-0 flex-1"
            />
          </div>

          {result !== null ? (
            result.length === 0 ? (
              <div className="text-success flex shrink-0 items-center gap-2 text-sm" role="status">
                <IconCircleCheck aria-hidden className="size-4" />
                Payload conforms to &lsquo;{kindName}&rsquo;.
              </div>
            ) : (
              <div role="alert" className="border-destructive/40 bg-destructive/10 shrink-0 rounded-md border p-3 text-sm">
                <p className="text-destructive mb-1 font-medium">Payload does not conform:</p>
                <ul className="text-destructive flex flex-col gap-0.5">
                  {result.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button type="button" onClick={handleValidate}>
              <IconFlask aria-hidden />
              Validate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
