/**
 * Shape of the baked build-info contract.
 *
 * Mirrors.
 * Kept hand-in-sync with that JSON Schema rather than generated from it —
 * the schema is the frozen source of truth; this is its TS projection.
 */
export interface BuildInfo {
  service: string;
  version: string;
  releaseTag: string | null;
  gitBranch: string;
  gitCommitSha: string;
  buildAt: string;
  ciPipelineId: string | null;
  ciPipelineUrl: string | null;
}
