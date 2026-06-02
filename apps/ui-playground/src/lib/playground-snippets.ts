/**
 * TASK-329 — LiveCodePanel snippet builders.
 *
 * Pure functions that turn the *current* playground store / impersonated-user
 * preferences into a copy-pasteable `@arcaai/vox` code sample. They are kept free
 * of React so each builder is trivially unit-testable and the panel can re-render
 * reactively whenever the inputs change.
 *
 * Every symbol referenced in a snippet (`useRealtimeTranscription`,
 * `useConsultationChain`, `resolveVoiceEnrollmentProvider`, …) is a real export of
 * the corresponding playground feature or `@arcaai/vox`, so the samples stay honest.
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
    ...(ctx.isSuperAdmin ? [`  // super-admin: switch tenants at runtime via AgenticProvider.updateTenantId()`] : []),
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
    `import { useRealtimeTranscription } from '@arcaai/vox';`,
    ``,
    contextHeader(ctx),
    `export function LiveCaption() {`,
    `  const { transcript, isRecording, start, stop } = useRealtimeTranscription({`,
    `    model: '${model}',`,
    `    task: '${task}',`,
    `    language: '${language}',`,
    `  });`,
    ``,
    `  return (`,
    `    <button onClick={isRecording ? stop : start}>`,
    `      {isRecording ? 'Stop' : 'Start'} — {transcript}`,
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
    `import { useMyDnaStyle, useGenerateDnaReport } from '@/features/dna-writing-style/api/dna-writing-styles';`,
    ``,
    contextHeader(ctx),
    `// current style: ${current}`,
    `export function GenerateStyle(textSamples: string[]) {`,
    `  const { data: style } = useMyDnaStyle();`,
    `  const generate = useGenerateDnaReport();`,
    ``,
    `  generate.mutate({ textSamples });`,
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
  return [
    contextHeader(ctx),
    `// SMR generate — reflects the current Generation Settings`,
    `const request = {`,
    `  provider: '${provider}',`,
    `  model: '${model}',`,
    `  promptTemplateId: ${optStr(ctx.promptTemplateId)},`,
    `  dnaStyleId: ${optStr(ctx.dnaStyleId)},`,
    `  temperature: ${temperature},`,
    `  maxTokens: ${maxTokens},`,
    `  includeNER: ${Boolean(ctx.includeNER)},`,
    `  stream: ${Boolean(ctx.streaming)},`,
    `};`,
  ].join('\n');
}
