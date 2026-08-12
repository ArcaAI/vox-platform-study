'use client';

/**
 * Definition tab (TASK-666): the kind editor + output-kind editor + publish
 * flow over `POST :id/publish` (TASK-658 §3.2). The draft lives in the
 * parent drawer (`ContextSchemaDetailDrawer`) so the Tester tab can validate
 * sample payloads against the SAME in-progress draft, not a stale published
 * copy.
 *
 * Publish surfaces the server's actual rejection reasons rather than a
 * generic error (`publishRejection`): a structural 400 lists every
 * `problems[]` entry inline; a refused breaking change lists every
 * `breakingChanges[]` entry and offers an explicit "Publish anyway"
 * acknowledgement (`allowBreakingChange: true`) — never a silent retry.
 */

import { useId, useState } from 'react';
import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@arcaai/ui/components/shadcn/accordion';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { usePublishContextSchema } from '../api/hooks';
import type { ContextKindDeclaration, ContextOutputDeclaration, ContextSchemaDefinition } from '../api/types';
import { publishRejection } from '../lib/publish-error';
import { KindForm } from './kind-form';
import { OutputForm } from './output-form';

function defaultKind(): ContextKindDeclaration {
  return {
    key: '',
    label: '',
    primitive: 'TEXT',
    phiClass: 'PHI',
    cardinality: 'ONE',
    lifecycle: 'ANY',
    producedBy: ['CLIENT'],
  };
}

function defaultOutput(): ContextOutputDeclaration {
  return { key: '', primitive: 'STRUCTURED' };
}

export function DefinitionEditor({
  schemaId,
  definition,
  onDefinitionChange,
  onPublished,
}: {
  schemaId: string;
  definition: ContextSchemaDefinition;
  onDefinitionChange: (next: ContextSchemaDefinition) => void;
  onPublished: () => void;
}) {
  const uid = useId();
  const publish = usePublishContextSchema();
  const [changeReason, setChangeReason] = useState('');
  const [breakingChanges, setBreakingChanges] = useState<string[] | null>(null);
  const problems = publish.error instanceof GatewayError ? (publishRejection(publish.error)?.problems ?? null) : null;

  function updateKind(index: number, next: ContextKindDeclaration) {
    onDefinitionChange({ ...definition, kinds: definition.kinds.map((kind, i) => (i === index ? next : kind)) });
  }

  function removeKind(index: number) {
    onDefinitionChange({ ...definition, kinds: definition.kinds.filter((_, i) => i !== index) });
  }

  function addKind() {
    onDefinitionChange({ ...definition, kinds: [...definition.kinds, defaultKind()] });
  }

  const outputs = definition.outputs ?? [];

  function updateOutput(index: number, next: ContextOutputDeclaration) {
    onDefinitionChange({ ...definition, outputs: outputs.map((output, i) => (i === index ? next : output)) });
  }

  function removeOutput(index: number) {
    onDefinitionChange({ ...definition, outputs: outputs.filter((_, i) => i !== index) });
  }

  function addOutput() {
    onDefinitionChange({ ...definition, outputs: [...outputs, defaultOutput()] });
  }

  function runPublish(allowBreakingChange?: boolean) {
    publish.mutate(
      { id: schemaId, body: { definition, changeReason: changeReason.trim() || undefined, allowBreakingChange } },
      {
        onSuccess: () => {
          toast.success('Definition published');
          setBreakingChanges(null);
          setChangeReason('');
          onPublished();
        },
        onError: (error) => {
          const rejection = publishRejection(error);
          if (rejection?.breakingChanges) {
            setBreakingChanges(rejection.breakingChanges);
            return;
          }
          setBreakingChanges(null);
          if (rejection?.problems) return; // rendered inline below — no redundant toast
          toast.error(error instanceof GatewayError ? error.message : 'Could not publish the definition.');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Kinds ({definition.kinds.length})</h3>
          <Button type="button" size="sm" variant="outline" onClick={addKind}>
            <IconPlus aria-hidden />
            Add kind
          </Button>
        </div>
        {definition.kinds.length === 0 ? (
          <EmptyState icon={IconPlus} title="No kinds yet" description="Add at least one kind before publishing this definition." />
        ) : (
          <Accordion type="multiple" className="rounded-md border px-3">
            {definition.kinds.map((kind, index) => (
              <AccordionItem key={index} value={`kind-${index}`}>
                <AccordionTrigger>
                  <span className="flex flex-wrap items-center gap-2 text-left">
                    <span className="font-mono text-sm">{kind.key || `kind ${index + 1}`}</span>
                    <Badge variant="outline">{kind.primitive}</Badge>
                    {kind.required ? <Badge variant="secondary">Required</Badge> : null}
                    {kind.deprecated ? <Badge variant="secondary">Deprecated</Badge> : null}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <KindForm kind={kind} onChange={(next) => updateKind(index, next)} onRemove={() => removeKind(index)} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Outputs ({outputs.length})</h3>
          <Button type="button" size="sm" variant="outline" onClick={addOutput}>
            <IconPlus aria-hidden />
            Add output
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">What the loop may emit back — optional.</p>
        {outputs.length > 0 ? (
          <Accordion type="multiple" className="rounded-md border px-3">
            {outputs.map((output, index) => (
              <AccordionItem key={index} value={`output-${index}`}>
                <AccordionTrigger>
                  <span className="flex flex-wrap items-center gap-2 text-left">
                    <span className="font-mono text-sm">{output.key || `output ${index + 1}`}</span>
                    <Badge variant="outline">{output.primitive}</Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <OutputForm output={output} onChange={(next) => updateOutput(index, next)} onRemove={() => removeOutput(index)} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : null}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Publish</h3>

        {problems && problems.length > 0 ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>The definition is not publishable</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-0.5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {breakingChanges ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>This change breaks clients built against the current version</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-0.5">
                {breakingChanges.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setBreakingChanges(null)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" size="sm" disabled={publish.isPending} onClick={() => runPublish(true)}>
                  {publish.isPending ? <Spinner /> : null}
                  Publish anyway
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-change-reason`}>Change reason (optional)</Label>
              <Input
                id={`${uid}-change-reason`}
                value={changeReason}
                onChange={(event) => setChangeReason(event.target.value)}
                placeholder="Add referral_letter kind for cardiology intake"
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" disabled={definition.kinds.length === 0 || publish.isPending} onClick={() => runPublish()}>
                {publish.isPending ? <Spinner /> : null}
                Publish
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
