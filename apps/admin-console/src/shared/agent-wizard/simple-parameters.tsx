'use client';

/**
 * TASK-1036 C5 (W2, §8.6) — the SIMPLE agent settings, replacing the raw parameter tree on every
 * tenant surface.
 *
 *   - ASR:  voice activity detection, noise suppression, speaker separation (+ an enrollment hint).
 *   - Text: DNA rewrite, document template (always the latest approved version — W3, OD-22),
 *           structured output, and temperature / max output tokens ONLY when the bound model
 *           supports them (a reasoning model takes no temperature).
 *   - TTS:  a voice picker over the model's own `capabilities.voices`, and a speed.
 *
 * Everything else — decoding, thresholds, top-p/k, penalties, seed, the reasoning posture — is
 * platform-managed (OD-11 / W2): hidden here, and the gateway answers a tenant's write with 403
 * `AGENT_PARAMETER_PLATFORM_MANAGED`. A super admin gets it in a collapsed "Platform tuning"
 * section. Guardrails are always on (OD-1), shown as a read-only row, never a switch.
 *
 * Untouched knobs stay ABSENT from `parameters` (the runtime default wins); a cleared field
 * deletes its key, via the same `setPath` the full form uses.
 */
import { useId } from 'react';
import Link from 'next/link';
import { IconExternalLink, IconShieldCheck } from '@tabler/icons-react';
import { AGENT_PARAMETER_SCHEMAS, type AgentTask } from '@arcaai/workflow-contract';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { getPath, props, setPath, type Schema, type Value } from '@/shared/agent-parameters';
import { useSession } from '@/shared/auth';
import { isServableDocumentTemplate, useDocumentTemplateCatalog } from '@/shared/catalog';
import { JsonField, ParametersForm, useTaskModelCatalogue } from './agents-feature';
import { capabilitiesOf, hasEditablePath, type WithCapabilities } from './capabilities';

const NO_TEMPLATE = '__none__';
const VOICE_PROFILES_HREF = '/playground/voice-profiles';

/** The contract's own leaf schema for `path` — min / max / default come from here, never from this file. */
function leafSchema(task: AgentTask, path: string): Schema {
  let node = AGENT_PARAMETER_SCHEMAS[task] as Schema;
  for (const key of path.split('.')) node = props(node)[key] ?? {};
  return node;
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  children,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <Label htmlFor={id}>{label}</Label>
          <span id={`${id}-desc`} className="text-muted-foreground text-xs">
            {description}
          </span>
        </div>
        <Switch id={id} checked={checked} disabled={disabled} aria-describedby={`${id}-desc`} onCheckedChange={onChange} />
      </div>
      {children}
    </div>
  );
}

function NumberField({
  id,
  label,
  description,
  schema,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  description?: string;
  schema: Schema;
  value: unknown;
  onChange: (next: number | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={value === undefined ? '' : String(value)}
        min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
        max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
        step={schema.type === 'integer' ? 1 : 'any'}
        disabled={disabled}
        aria-describedby={description ? `${id}-desc` : undefined}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
      {description ? (
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export interface AgentSimpleParametersProps {
  task: AgentTask;
  /** The bound primary model; capabilities are read off its catalogue row. Empty until one is chosen. */
  modelId: string;
  /** `Agent.parameters` — edited in place, untouched knobs stay absent. */
  value: Value;
  onChange: (next: Value) => void;
  /** TEXT_GENERATION only: `instruction.documentTemplate.slug` (lives on the instruction, not in `parameters`). */
  documentTemplateSlug?: string | null;
  onDocumentTemplateChange?: (slug: string | null) => void;
  disabled?: boolean;
}

export function AgentSimpleParameters({ task, modelId, value, onChange, documentTemplateSlug = null, onDocumentTemplateChange, disabled }: AgentSimpleParametersProps) {
  const idPrefix = useId();
  const catalogue = useTaskModelCatalogue(task);
  const session = useSession();
  const templates = useDocumentTemplateCatalog();
  const elevated = session.data?.effectiveIsElevated ?? false;

  if (catalogue.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  const model = catalogue.models.find((candidate) => candidate.id === modelId);
  // OD-16 — no section exists for tools or attachments (`futureSectionsFor`), whatever the model declares.
  const capabilities = capabilitiesOf(model as WithCapabilities | undefined);
  const offered = (path: string) => hasEditablePath(task, capabilities, path);

  const set = (path: string, next: unknown) => onChange(setPath(value, path.split('.'), next));
  const effectiveBoolean = (path: string) => {
    const stored = getPath(value, path.split('.'));
    return stored === undefined ? leafSchema(task, path).default === true : stored === true;
  };
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  const diarizationOn = effectiveBoolean('audioFrontEnd.diarization.enabled');
  const servableTemplates = (templates.data ?? []).filter(isServableDocumentTemplate);
  const knownTemplate = documentTemplateSlug === null || servableTemplates.some((template) => template.slug === documentTemplateSlug);
  const responseFormat = (getPath(value, ['responseFormat']) as string | undefined) ?? 'text';

  return (
    <div className="flex flex-col gap-4">
      {task === 'SPEECH_TO_TEXT' ? (
        <>
          <SwitchRow
            id={id('vad')}
            label="Voice activity detection"
            description="Skip silence so only speech is transcribed."
            checked={effectiveBoolean('audioFrontEnd.vad.enabled')}
            onChange={(next) => set('audioFrontEnd.vad.enabled', next)}
            disabled={disabled}
          />
          <SwitchRow
            id={id('denoise')}
            label="Noise suppression"
            description="Reduce background noise before transcription."
            checked={effectiveBoolean('audioFrontEnd.denoise.enabled')}
            onChange={(next) => set('audioFrontEnd.denoise.enabled', next)}
            disabled={disabled}
          />
          <SwitchRow
            id={id('diarization')}
            label="Speaker separation (diarization)"
            description="Label who is speaking."
            checked={diarizationOn}
            onChange={(next) => set('audioFrontEnd.diarization.enabled', next)}
            disabled={disabled}
          >
            <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
              <span>Speakers are matched against enrolled voice profiles; unmatched voices are labelled generically.</span>
              <Link href={VOICE_PROFILES_HREF} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                Enroll voices <span className="sr-only">(opens in a new tab)</span> <IconExternalLink aria-hidden className="size-3" />
              </Link>
            </div>
          </SwitchRow>
        </>
      ) : null}

      {task === 'TEXT_GENERATION' ? (
        <>
          <SwitchRow
            id={id('dna')}
            label="Apply the clinician's DNA writing style"
            description="Rewrites the output in the clinician's own style, always from their latest report. The clinician's opt-out still applies."
            checked={effectiveBoolean('dna.enabled')}
            onChange={(next) => set('dna.enabled', next)}
            disabled={disabled}
          />
          {onDocumentTemplateChange ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id('document-template')}>Document template</Label>
              {templates.isPending ? (
                <Skeleton className="h-9 w-full" aria-busy="true" />
              ) : (
                <Select
                  value={documentTemplateSlug ?? NO_TEMPLATE}
                  onValueChange={(next) => onDocumentTemplateChange(next === NO_TEMPLATE ? null : next)}
                  disabled={disabled}
                >
                  <SelectTrigger id={id('document-template')} className="w-full" aria-describedby={id('document-template-desc')}>
                    <SelectValue placeholder="Platform layout" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>None — platform layout</SelectItem>
                    {!knownTemplate && documentTemplateSlug ? <SelectItem value={documentTemplateSlug}>{documentTemplateSlug} (not available)</SelectItem> : null}
                    {servableTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.slug}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p id={id('document-template-desc')} className="text-muted-foreground text-xs">
                The agent always uses the latest approved version of the template; it is never pinned.
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id('response-format')}>Structured output</Label>
            <Select value={responseFormat} onValueChange={(next) => set('responseFormat', next === 'text' ? undefined : next)} disabled={disabled}>
              <SelectTrigger id={id('response-format')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Plain text</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="json_schema">JSON matching a schema</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {responseFormat === 'json_schema' ? (
            <JsonField
              label="Response schema"
              description="The JSON Schema the response must satisfy."
              value={(getPath(value, ['responseSchema']) as Value | undefined) ?? null}
              onChange={(next) => set('responseSchema', next ?? undefined)}
              rows={6}
            />
          ) : null}
          {offered('generation.temperature') ? (
            <NumberField
              id={id('temperature')}
              label="Temperature"
              description="Lower is more consistent; higher is more varied."
              schema={leafSchema(task, 'generation.temperature')}
              value={getPath(value, ['generation', 'temperature'])}
              onChange={(next) => set('generation.temperature', next)}
              disabled={disabled}
            />
          ) : null}
          {offered('generation.maxTokens') ? (
            <NumberField
              id={id('max-tokens')}
              label="Max output tokens"
              schema={leafSchema(task, 'generation.maxTokens')}
              value={getPath(value, ['generation', 'maxTokens'])}
              onChange={(next) => set('generation.maxTokens', next)}
              disabled={disabled}
            />
          ) : null}
        </>
      ) : null}

      {task === 'TEXT_TO_SPEECH' ? (
        <>
          {offered('voice') ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id('voice')}>Voice</Label>
              <Select value={(getPath(value, ['voice']) as string | undefined) ?? ''} onValueChange={(next) => set('voice', next)} disabled={disabled}>
                <SelectTrigger id={id('voice')} className="w-full">
                  <SelectValue placeholder="Model default" />
                </SelectTrigger>
                <SelectContent>
                  {(capabilities?.voices ?? []).map((voice) => (
                    <SelectItem key={voice} value={voice}>
                      {voice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <NumberField
            id={id('speed')}
            label="Speed"
            description="1 is the voice's natural pace."
            schema={leafSchema(task, 'speed')}
            value={getPath(value, ['speed'])}
            onChange={(next) => set('speed', next)}
            disabled={disabled}
          />
        </>
      ) : null}

      {/* OD-1 — guardrails are not an option: the platform screens every agent's input and output. */}
      <div className="bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <IconShieldCheck aria-hidden className="text-success size-4 shrink-0" />
        <span className="font-medium">Guardrails: always on</span>
        <span className="text-muted-foreground text-xs">The platform screens this agent&apos;s inputs and outputs.</span>
      </div>

      {elevated ? (
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Platform tuning</summary>
          <div className="flex flex-col gap-3 pt-3">
            <p className="text-muted-foreground text-xs">
              Managed by the platform: the same for every tenant. Only a platform administrator can change these.
            </p>
            <ParametersForm task={task} value={value} onChange={onChange} modelId={modelId} scope="platform" />
          </div>
        </details>
      ) : null}
    </div>
  );
}
