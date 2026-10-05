/**
 * TASK-1036 W2 — the agent described in plain words.
 *
 * Pure helpers behind the drawer's Overview, the read-only draft summary and the version compare:
 * each turns a stored agent (task + `parameters` + `instruction` + I/O schemas) into short
 * label/value facts a tenant admin can read without knowing the parameter tree. Defaults come
 * from the contract (`AGENT_PARAMETER_SCHEMAS`, `AGENT_IO_DEFAULTS`), never from this file, so a
 * stage that runs by default reads "On" even when the agent stores nothing for it.
 */
import { AGENT_IO_DEFAULTS, AGENT_PARAMETER_SCHEMAS } from '@arcaai/workflow-contract';
import type { AgentTask } from '../api';

/** One line of what the task does, for the Overview's "What it does" row. */
export const AGENT_TASK_PURPOSE: Record<AgentTask, string> = {
  SPEECH_TO_TEXT: 'Turns recorded or live speech into text.',
  TEXT_GENERATION: 'Writes text — notes, summaries, letters — from a prompt and the input it is given.',
  TEXT_TO_SPEECH: 'Reads text aloud in a chosen voice.',
  NAMED_ENTITY_RECOGNITION: 'Finds and labels clinical terms (medicines, conditions, procedures…) in text.',
};

export interface Fact {
  label: string;
  value: string;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function at(value: unknown, path: string): unknown {
  let node = value;
  for (const key of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** The contract's declared default for a parameter leaf (`undefined` when it declares none). */
function schemaDefault(task: AgentTask, path: string): unknown {
  let node: unknown = AGENT_PARAMETER_SCHEMAS[task];
  for (const key of path.split('.')) {
    const properties = isRecord(node) ? node.properties : undefined;
    node = isRecord(properties) ? properties[key] : undefined;
  }
  return isRecord(node) ? node.default : undefined;
}

function onOff(task: AgentTask, parameters: unknown, path: string): string {
  const stored = at(parameters, path);
  const effective = typeof stored === 'boolean' ? stored : schemaDefault(task, path) === true;
  return effective ? 'On' : 'Off';
}

const LANGUAGE_LABEL: Record<string, string> = {
  en: 'English',
  ml: 'Malayalam',
  'ml-en': 'Malayalam–English (code-switched)',
  vi: 'Vietnamese',
  'vi-en': 'Vietnamese–English (code-switched)',
  auto: 'Detect automatically',
};

export function languageLabel(mode: unknown): string {
  if (typeof mode !== 'string' || mode === '') return 'Model default';
  return LANGUAGE_LABEL[mode] ?? mode;
}

const RESPONSE_FORMAT_LABEL: Record<string, string> = {
  text: 'Plain text',
  json: 'JSON',
  json_schema: 'JSON matching a schema',
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

/**
 * The §8.6 task switches as plain facts — the same set the simple editor offers, read back.
 * `documentTemplateName` resolves the TEXT agent's template slug to its display name when the
 * caller has the catalogue; the slug stands in otherwise.
 */
export function taskSwitchFacts(
  task: AgentTask,
  parameters: unknown,
  instruction: unknown,
  { documentTemplateName }: { documentTemplateName?: (slug: string) => string | undefined } = {},
): Fact[] {
  if (task === 'SPEECH_TO_TEXT') {
    return [
      { label: 'Voice activity detection', value: onOff(task, parameters, 'audioFrontEnd.vad.enabled') },
      { label: 'Noise suppression', value: onOff(task, parameters, 'audioFrontEnd.denoise.enabled') },
      { label: 'Speaker separation (diarization)', value: onOff(task, parameters, 'audioFrontEnd.diarization.enabled') },
      { label: 'Language', value: languageLabel(at(parameters, 'decoding.languageMode')) },
    ];
  }
  if (task === 'TEXT_GENERATION') {
    const slug = at(instruction, 'documentTemplate.slug');
    const format = at(parameters, 'responseFormat');
    return [
      { label: "Clinician's writing style (DNA)", value: onOff(task, parameters, 'dna.enabled') },
      { label: 'Document template', value: typeof slug === 'string' ? (documentTemplateName?.(slug) ?? slug) : 'None — platform layout' },
      { label: 'Structured output', value: RESPONSE_FORMAT_LABEL[typeof format === 'string' ? format : 'text'] ?? String(format) },
    ];
  }
  if (task === 'TEXT_TO_SPEECH') {
    const voice = at(parameters, 'voice');
    const speed = at(parameters, 'speed');
    return [
      { label: 'Voice', value: typeof voice === 'string' && voice ? voice : 'Model default' },
      { label: 'Speed', value: typeof speed === 'number' ? `${speed}×` : 'Natural (1×)' },
    ];
  }
  const labels = stringList(at(instruction, 'labels'));
  return [{ label: 'What it looks for', value: labels.length ? labels.join(', ') : "The model's own labels" }];
}

/**
 * Temperature and max output tokens — the ONLY two generation settings a tenant sees (W2), and
 * only when the agent sets them AND the bound model supports them (`offered`).
 */
export function generationFacts(parameters: unknown, offered: (path: string) => boolean): Fact[] {
  const facts: Fact[] = [];
  const temperature = at(parameters, 'generation.temperature');
  if (typeof temperature === 'number' && offered('generation.temperature')) facts.push({ label: 'Temperature', value: String(temperature) });
  const maxTokens = at(parameters, 'generation.maxTokens');
  if (typeof maxTokens === 'number' && offered('generation.maxTokens')) facts.push({ label: 'Max output tokens', value: maxTokens.toLocaleString('en') });
  return facts;
}

/** The speech-to-text agent's own prompt: a short context hint and key terms. */
export function asrHintFacts(instruction: unknown): Fact[] {
  const facts: Fact[] = [];
  const hint = at(instruction, 'initialPrompt');
  if (typeof hint === 'string' && hint.trim()) facts.push({ label: 'Context hint', value: hint });
  const terms = stringList(at(instruction, 'hotwords'));
  if (terms.length) facts.push({ label: 'Key terms', value: terms.join(', ') });
  return facts;
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

const TYPE_WORDS: Record<string, string> = {
  string: 'Text',
  number: 'Number',
  integer: 'Whole number',
  boolean: 'Yes / no',
  array: 'List',
  object: 'Group of fields',
  null: 'Empty',
};

function typeInWords(name: string, schema: Json): string {
  if (name === 'audio') return 'Audio';
  if (schema.format === 'date' || schema.format === 'date-time') return 'Date';
  if (Array.isArray(schema.enum) && schema.enum.length) return `One of: ${schema.enum.map(String).join(', ')}`;
  const type = Array.isArray(schema.type) ? schema.type.find((candidate) => candidate !== 'null') : schema.type;
  if (type === 'array') {
    const items = isRecord(schema.items) ? schema.items : {};
    const itemType = typeof items.type === 'string' ? TYPE_WORDS[items.type] : undefined;
    return itemType ? `List of ${itemType.toLowerCase()}` : 'List';
  }
  return typeof type === 'string' ? (TYPE_WORDS[type] ?? type) : 'Any';
}

/** The top-level fields of a JSON schema, one row each; deprecated aliases are left out. */
export function schemaFields(schema: unknown): SchemaField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(stringList(schema.required));
  return Object.entries(schema.properties)
    .filter(([, property]) => !(isRecord(property) && property.deprecated === true))
    .map(([name, property]) => {
      const node = isRecord(property) ? property : {};
      return {
        name,
        type: typeInWords(name, node),
        required: required.has(name),
        ...(typeof node.description === 'string' ? { description: node.description.replace(/`/g, '') } : {}),
      };
    });
}

/** The schema an agent actually runs with: its own, or the task's standard one. */
export function effectiveIoSchema(task: AgentTask, side: 'input' | 'output', own: Json | null): { schema: unknown; isStandard: boolean } {
  if (own) return { schema: own, isStandard: false };
  const defaults = AGENT_IO_DEFAULTS[task];
  return { schema: side === 'input' ? defaults.inputSchema : defaults.outputSchema, isStandard: true };
}
