'use client';

/**
 * Definition tab: the kind editor + output-kind editor.
 *
 * Publish USED to live at the bottom of this panel, behind a change-reason
 * input and a pair of inline alerts. It is now the page's single primary
 * action, and its confirmation states the effect (`PublishConfirmDialog`) — so
 * what remains here is editing, plus the one rejection that is genuinely about
 * the definition itself: a STRUCTURAL problem naming the field that is wrong.
 * A breaking change and a refusing consumer are decisions, not defects, and are
 * made in the dialog.
 *
 * The draft lives in the parent screen so the footer can report it and the
 * route guard can block a navigation that would discard it.
 */

import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@arcaai/ui/components/shadcn/accordion';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { EmptyState } from '@/shared/state/empty-state';
import type { ContextKindDeclaration, ContextOutputDeclaration, ContextSchemaDefinition } from '../api/types';
import { KindForm } from './kind-form';
import { OutputForm } from './output-form';
import { KindPayloadTester } from './payload-tester';

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
  definition,
  onDefinitionChange,
  problems,
}: {
  definition: ContextSchemaDefinition;
  onDefinitionChange: (next: ContextSchemaDefinition) => void;
  /** Structural rejections from the last publish attempt — rendered against the fields they name. */
  problems: string[] | null;
}) {
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

  return (
    <div className="flex flex-col gap-6">
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

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Kinds ({definition.kinds.length})</h2>
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
                    {kind.userIdentity ? (
                      <Badge variant="secondary" aria-label={`Identity field: ${kind.userIdentity.field}`}>
                        Identity
                      </Badge>
                    ) : null}
                    {kind.department ? (
                      <Badge variant="secondary" aria-label={`Department field: ${kind.department.field} (by ${kind.department.by})`}>
                        Department
                      </Badge>
                    ) : null}
                    {kind.visitType ? (
                      <Badge variant="secondary" aria-label={`Visit type field: ${kind.visitType.field}`}>
                        Visit type
                      </Badge>
                    ) : null}
                    {kind.externalRef ? (
                      <Badge variant="secondary" aria-label={`Reference id field: ${kind.externalRef.field}`}>
                        Reference id
                      </Badge>
                    ) : null}
                    {kind.streamContext ? (
                      <Badge variant="secondary" aria-label={`Stream context kind: ${kind.key}`}>
                        Stream
                      </Badge>
                    ) : null}
                    {kind.materializeAs ? (
                      <Badge variant="secondary" aria-label="Case notes field: notes">
                        Case notes
                      </Badge>
                    ) : null}
                    {kind.deprecated ? <Badge variant="secondary">Deprecated</Badge> : null}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-4">
                    <KindForm
                      kind={kind}
                      index={index}
                      kinds={definition.kinds}
                      onChange={(next) => updateKind(index, next)}
                      onRemove={() => removeKind(index)}
                    />
                    <div className="flex justify-end">
                      <KindPayloadTester kind={kind} />
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Outputs ({outputs.length})</h2>
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
    </div>
  );
}
