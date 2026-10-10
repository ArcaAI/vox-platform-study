import type { AgentValidationReport } from '../api/types';

/** The ERROR findings that block a publish, as one short sentence for a toast / disabled-button reason. */
export function blockingSummary(report: AgentValidationReport | null | undefined): string | null {
  if (!report?.blocking) return null;
  const errors = report.findings.filter((finding) => finding.severity === 'ERROR');
  const shown = (errors.length > 0 ? errors : report.findings).slice(0, 3).map((finding) => finding.message);
  if (shown.length === 0) return 'Validation found blocking problems.';
  const more = (errors.length || report.findings.length) - shown.length;
  return `${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
}
