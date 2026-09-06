/**
 * Copy-pasteable `@arcaai/vox-node` snippets shown to a TENANT'S DEVELOPER after they publish
 * an agent or a workflow (TASK-890 §3.9/§3.10).
 *
 * ## Why this file exists rather than a local helper in each dialog
 *
 * Everything in here is RENDERED DOCUMENTATION: prose about how the CONSUMER configures THEIR
 * service, including their own `process.env.HOPE_API_KEY`. `scripts/env-sync.mts` scans the
 * repository for `process.env.X` to build `turbo.json#globalEnv`, and a name it finds becomes
 * part of HOPE's declared environment surface and of the turbo cache key — which these names
 * must never be, because this repo does not read them.
 *
 * The scanner's exemption is `DOCUMENTATION_SURFACES`, and it is deliberately a list of
 * DIRECTORIES, never single files (`env-sync.test.ts` asserts it: a per-file skip could silently
 * hide a genuine read, because the console's ESLint preset carries no `turbo/*` rules to catch
 * one). So a snippet belongs in a documentation TREE. `features/developer-docs/` is the portal's
 * own; this is the shared one the publish dialogs use, and features may import from `shared/`
 * (rule 13) while they may never import each other.
 *
 * Two consequences to keep in mind when editing this file:
 *  - write snippets as TEMPLATE literals — the scanner blanks those, not quoted strings;
 *  - never read a real environment variable here. Nothing in a documentation surface is scanned,
 *    so a genuine read placed here would go undeclared and miss the cache key.
 */

const HEADER_LINES = [`import { HopeClient } from '@arcaai/vox-node';`, ``];

/** The client construction every snippet opens with — the consumer's own two variables. */
const CLIENT_WITH_BASE_URL = `const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL, apiKey: process.env.HOPE_API_KEY });`;
const CLIENT_KEY_ONLY = `const hope = new HopeClient({ apiKey: process.env.HOPE_API_KEY! });`;

/** The agent task shapes the business plane exposes — one call per task, never a generic one. */
export type SdkSnippetAgentTask = 'TEXT_GENERATION' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH';

/** Invoke / synthesize / transcribe a published agent by slug. */
export function agentVoxNodeSnippet(slug: string, task: SdkSnippetAgentTask): string {
  const call =
    task === 'TEXT_GENERATION'
      ? `const { output } = await hope.agents.invoke('${slug}', { text: '…' });`
      : task === 'TEXT_TO_SPEECH'
        ? `const speech = await hope.agents.synthesize('${slug}', { text: '…' });`
        : `const job = await hope.agents.transcribe('${slug}', { file });`;
  return [...HEADER_LINES, CLIENT_WITH_BASE_URL, ``, call].join('\n');
}

/** Start a blocking run of a published workflow by slug. */
export function workflowVoxNodeSnippet(slug: string): string {
  return [
    ...HEADER_LINES,
    CLIENT_KEY_ONLY,
    ``,
    `const run = await hope.workflows.runs.create('${slug}', {`,
    `  input: { /* this workflow's trigger payload */ },`,
    `  mode: 'blocking',`,
    `});`,
  ].join('\n');
}
