/**
 * The words the publish confirmation says, derived from the impact rather than
 * written per case at the call site.
 *
 * Two independent facts decide what an admin is being asked to accept, and they
 * are deliberately NOT merged:
 *
 *   • **Client compatibility** — does this version break apps already built on
 *     the current one? That is the server's `breakingChanges`, acknowledged with
 *     `allowBreakingChange`.
 *   • **Consumer compatibility** — would a workflow or agent that FROZE an older
 *     version now refuse the payloads this version admits? That is the `impact`,
 *     acknowledged with `acknowledgeImpact`.
 *
 * A change can be either, both, or neither. The breaking variant wins the
 * headline because it is the one that reaches outside this console.
 *
 * Only ACTIVE consumers gate the publish: a disabled or draft workflow refuses
 * nothing today, so blocking on it would train admins to tick past the checkbox.
 */

import type { ContextSchemaAgentUsage, ContextSchemaUsagesResponse, ContextSchemaWorkflowUsage } from '../api/types';

export type PublishCopyVariant = 'all-accept' | 'some-refuse' | 'breaking';

/** One consumer named in the confirmation's list. */
export interface RefusingConsumer {
  key: string;
  name: string;
  kind: 'workflow' | 'agent';
  /** "pinned v2" — why it refuses, in the admin's language. */
  boundLabel: string;
  problems: string[];
}

export interface PublishCopy {
  variant: PublishCopyVariant;
  title: string;
  description: string;
  /** Consumers that would refuse — listed in the dialog body, refusing ones first. */
  refusing: RefusingConsumer[];
  /** The server's client-compatibility diff, when it refused the publish. */
  breakingChanges: string[] | null;
  /** `null` when nothing needs accepting; otherwise the checkbox label AND the visible reason. */
  acknowledgement: string | null;
  confirmLabel: string;
  destructive: boolean;
}

export interface PublishCopyInput {
  /** The version number this publish would create. */
  nextVersion: number;
  /** The version currently pinned — what existing apps are built on. `null` before the first publish. */
  currentVersion: number | null;
  /** New kind keys this version introduces (the server's `additions`). */
  additions: string[];
  /** Set only once the server has refused the publish as breaking. */
  breakingChanges: string[] | null;
  /** `null` when the usages read failed — say so rather than implying "nobody". */
  impact: ContextSchemaUsagesResponse | null;
}

function isWorkflow(row: ContextSchemaWorkflowUsage | ContextSchemaAgentUsage): row is ContextSchemaWorkflowUsage {
  return 'definitionId' in row;
}

function toRefusing(row: ContextSchemaWorkflowUsage | ContextSchemaAgentUsage): RefusingConsumer {
  return {
    key: isWorkflow(row) ? row.definitionId : row.agentId,
    name: row.name || row.slug,
    kind: isWorkflow(row) ? 'workflow' : 'agent',
    boundLabel: row.binding === 'pinned' ? `pinned v${row.boundVersion ?? '?'}` : 'follows latest',
    problems: row.problems,
  };
}

/** "one new kind, `referral`" / "2 new kinds: `a`, `b`" / "no new kinds". */
function additionsSentence(additions: string[]): string {
  if (additions.length === 0) return 'This adds no new kinds.';
  if (additions.length === 1) return `This adds one new kind, \`${additions[0]}\`.`;
  return `This adds ${additions.length} new kinds: ${additions.map((key) => `\`${key}\``).join(', ')}.`;
}

/** "2 workflows" / "1 agent" / "2 workflows and 1 agent" — never a bare count. */
function consumerPhrase(workflows: number, agents: number): string {
  const parts: string[] = [];
  if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? '' : 's'}`);
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

export function publishCopy({ nextVersion, currentVersion, additions, breakingChanges, impact }: PublishCopyInput): PublishCopy {
  const workflows = impact?.workflows ?? [];
  const agents = impact?.agents ?? [];
  const refusingRows = [...workflows, ...agents].filter((row) => row.verdict === 'refuses');
  const gatingRows = refusingRows.filter((row) => row.isActive);
  const refusing = refusingRows.map(toRefusing);

  if (breakingChanges && breakingChanges.length > 0) {
    return {
      variant: 'breaking',
      title: `This change breaks apps already using version ${currentVersion ?? nextVersion - 1}`,
      description: `${additionsSentence(additions)} Apps built on the current version will stop working until they are updated.`,
      refusing,
      breakingChanges,
      acknowledgement: 'I understand existing integrations will stop working until they are updated.',
      confirmLabel: 'Publish anyway',
      destructive: true,
    };
  }

  const followsLatest = [...workflows, ...agents].filter((row) => row.binding === 'latest').length;
  const compatibility = currentVersion != null ? ` Nothing is removed or renamed, so apps built on version ${currentVersion} keep working.` : '';

  if (gatingRows.length > 0) {
    const gatingWorkflows = gatingRows.filter(isWorkflow).length;
    const gatingAgents = gatingRows.length - gatingWorkflows;
    const phrase = consumerPhrase(gatingWorkflows, gatingAgents);
    const singular = gatingRows.length === 1;
    return {
      variant: 'some-refuse',
      title: `Publish version ${nextVersion}?`,
      description: `${additionsSentence(additions)}${compatibility} ${phrase} will refuse it, because ${singular ? 'it is' : 'they are'} pinned to an older version. ${singular ? 'It' : 'They'} will refuse any consultation that sends the new ${additions.length === 1 ? 'kind' : 'kinds'} until you republish ${singular ? 'it' : 'them'}:`,
      refusing,
      breakingChanges: null,
      acknowledgement: `I understand ${singular ? 'this' : 'these'} ${phrase} will refuse new consultations until ${singular ? 'it is' : 'they are'} republished.`,
      confirmLabel: 'Publish',
      destructive: false,
    };
  }

  const consumersSentence =
    impact === null
      ? ' The list of workflows and agents that use this schema could not be read, so this publish is unchecked against them.'
      : followsLatest > 0
        ? ` ${consumerPhrase(workflows.filter((row) => row.binding === 'latest').length, agents.filter((row) => row.binding === 'latest').length)} ${followsLatest === 1 ? 'follows' : 'follow'} the latest version and will accept it. None will refuse it.`
        : ' No workflow or agent will refuse it.';

  return {
    variant: 'all-accept',
    title: `Publish version ${nextVersion}?`,
    description: `${additionsSentence(additions)}${compatibility}${consumersSentence}`,
    refusing,
    breakingChanges: null,
    acknowledgement: null,
    confirmLabel: 'Publish',
    destructive: false,
  };
}
