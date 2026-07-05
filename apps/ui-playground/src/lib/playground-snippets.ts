/**
 * TASK-329 — LiveCodePanel snippet builders.
 *
 * Pure functions that turn the *current* playground store / impersonated-user
 * preferences into a copy-pasteable `@arcaai/vox` code sample. They are kept free
 * of React so each builder is trivially unit-testable and the panel can re-render
 * reactively whenever the inputs change.
 *
 * Every symbol referenced in a snippet (`useArcaAudio`, `useConsultationChain`,
 * `useDnaStyle`, `resolveVoiceEnrollmentProvider`, …) is a real export of
 * `@arcaai/vox`, so the samples stay honest and copy-paste runnable.
 */

export interface SnippetBaseContext {
  /** Active tenant id (null when none selected). */
  tenantId?: string | null;
  /** Label of the effective user — the impersonated username, or null. */
  userLabel?: string | null;
}

/** Shared first comment line: which tenant / user the sample is bound to. */
function contextHeader(ctx: SnippetBaseContext): string {
  const tenant = ctx.tenantId ?? '<select-a-tenant>';
  const acting = ctx.userLabel ? `, acting as @${ctx.userLabel}` : '';
  return `// tenant: ${tenant}${acting}`;
}

/** Render a string literal or `undefined` for optional id fields. */
function optStr(value?: string | null): string {
  return value ? `'${value}'` : 'undefined';
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface OverviewSnippetContext extends SnippetBaseContext {
  isSuperAdmin?: boolean;
}

export function buildOverviewSnippet(ctx: OverviewSnippetContext): string {
  return [
    `import { useAuth, useArcaConfig } from '@arcaai/vox';`,
    ``,
    contextHeader(ctx),
    `export function ConnectionStatus() {`,
    `  const { isImpersonating, impersonatedUser } = useAuth();`,
    `  const { configReady } = useArcaConfig();`,
    ...(ctx.isSuperAdmin ? [`  // global-admin: switch tenants at runtime via AgenticProvider.updateTenantId()`] : []),
    ``,
    `  if (!configReady) return 'loading…';`,
    `  return isImpersonating ? \`acting as \${impersonatedUser?.username}\` : 'ready';`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Consultation
// ---------------------------------------------------------------------------

export interface ConsultationSnippetContext extends SnippetBaseContext {
  consultationId?: string | null;
}

export function buildConsultationSnippet(ctx: ConsultationSnippetContext): string {
  const id = ctx.consultationId ?? '<open-a-consultation>';
  return [
    `import { useConsultationChain, useAudioRecordings } from '@arcaai/vox';`,
    ``,
    contextHeader(ctx),
    `// consultation: ${id}`,
    `export function ConsultationContext() {`,
    `  const { chain, fetchChain } = useConsultationChain();`,
    `  const { recordings, list } = useAudioRecordings();`,
    ``,
    `  // walk the full multi-hop chain + load dual-capture recordings`,
    `  void fetchChain(${optStr(ctx.consultationId)});`,
    `  void list(${optStr(ctx.consultationId)});`,
    `  return { chain, recordings };`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Audio / live transcription
// ---------------------------------------------------------------------------

export interface AudioSnippetContext extends SnippetBaseContext {
  modelId?: string | null;
  /** Whisper task — `transcribe` | `translate`. */
  task?: string | null;
  language?: string | null;
}

export function buildAudioSnippet(ctx: AudioSnippetContext): string {
  const model = ctx.modelId ?? 'whisper-base';
  const task = ctx.task ?? 'transcribe';
  const language = ctx.language ?? 'auto';
  return [
    `import { useArcaAudio } from '@arcaai/vox';`,
    ``,
    contextHeader(ctx),
    `// model: ${model} · task: ${task} · language: ${language}`,
    `// ↑ resolved from the tenant + impersonated-user config (ModelRegistry /`,
    `//   useArcaConfig); they are NOT passed to start() directly.`,
    `export function LiveCaption() {`,
    `  const { currentTranscript, isCapturing, startFromPreferences, stop } = useArcaAudio();`,
    ``,
    `  // startFromPreferences() drives capture from the impersonated user's`,
    `  // persisted prefs (device, language, local/backend STT workflow).`,
    `  return (`,
    `    <button onClick={isCapturing ? stop : startFromPreferences}>`,
    `      {isCapturing ? 'Stop' : 'Start'} — {currentTranscript}`,
    `    </button>`,
    `  );`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Voice profile
// ---------------------------------------------------------------------------

export interface VoiceSnippetContext extends SnippetBaseContext {
  /** Selected enrollment provider. */
  provider: 'backend' | 'local';
}

export function buildVoiceSnippet(ctx: VoiceSnippetContext): string {
  return [
    `import { resolveVoiceEnrollmentProvider, isLocalVoiceEmbeddingSupported } from '@arcaai/vox';`,
    ``,
    contextHeader(ctx),
    `// provider: ${ctx.provider}`,
    `const provider = resolveVoiceEnrollmentProvider({`,
    `  preferred: '${ctx.provider}',`,
    `  localSupported: isLocalVoiceEmbeddingSupported(),`,
    `});`,
    ctx.provider === 'local'
      ? `// → embeddings are computed in-browser; audio never leaves the device`
      : `// → embeddings are computed by the backend voice service`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// DNA writing style
// ---------------------------------------------------------------------------

export interface DnaSnippetContext extends SnippetBaseContext {
  reportId?: string | null;
  version?: number | null;
  tone?: string | null;
}

export function buildDnaSnippet(ctx: DnaSnippetContext): string {
  const current = ctx.reportId && ctx.version != null ? `v${ctx.version}${ctx.tone ? ` · ${ctx.tone}` : ''}` : 'none yet — generate one first';
  return [
    `import { useDnaStyle } from '@arcaai/vox';`,
    ``,
    contextHeader(ctx),
    `// current style: ${current}`,
    `export function GenerateStyle(textSamples: string[]) {`,
    `  const { style, generate } = useDnaStyle();`,
    ``,
    `  void generate({ textSamples });`,
    `  return style;`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

export interface SummarizationSnippetContext extends SnippetBaseContext {
  provider?: string;
  model?: string;
  promptTemplateId?: string | null;
  dnaStyleId?: string | null;
  /** F8 — assembled-route context item ids the summary is generated from. */
  contextItemIds?: string[] | null;
  temperature?: number;
  maxTokens?: number;
  includeNER?: boolean;
  streaming?: boolean;
}

export function buildSummarizationSnippet(ctx: SummarizationSnippetContext): string {
  const provider = ctx.provider ?? 'ollama';
  const model = ctx.model ?? '<auto>';
  const temperature = ctx.temperature ?? 0.4;
  const maxTokens = ctx.maxTokens ?? 4096;
  const contextItemIds = ctx.contextItemIds && ctx.contextItemIds.length > 0 ? `[${ctx.contextItemIds.map((id) => `'${id}'`).join(', ')}]` : '[]';
  return [
    contextHeader(ctx),
    `// SMR generate — assembled (ID-based) route; reflects the current Generation Settings`,
    `const request = {`,
    `  provider: '${provider}',`,
    `  model: '${model}',`,
    `  // assembled route: pass IDs, never raw template / DNA text`,
    `  prompt_template_id: ${optStr(ctx.promptTemplateId)},`,
    `  dna_writing_style_id: ${optStr(ctx.dnaStyleId)},`,
    `  context_item_ids: ${contextItemIds},`,
    `  temperature: ${temperature},`,
    `  maxTokens: ${maxTokens},`,
    `  includeNER: ${Boolean(ctx.includeNER)},`,
    `  stream: ${Boolean(ctx.streaming)},`,
    `};`,
  ].join('\n');
}
