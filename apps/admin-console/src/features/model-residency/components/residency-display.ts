/**
 * TASK-1005 §13 L-RUI — plain-language rendering helpers for the catalogue
 * screen. Pure functions (no JSX) so the "no raw enums" contract (§13.2) is
 * testable in isolation from the component tree: `status`, `keepPolicy.kind`,
 * device ids and the `PINNED`/`WARM`/`ON_DEMAND` write-side class never reach
 * the DOM directly — everything here builds a sentence instead.
 */

import { formatBytes } from '@/shared/format';
import type {
  ResidencyAction,
  ResidencyCatalogueModel,
  ResidencyDevice,
  ResidencyKeepPolicyKind,
  ResidencyPolicyClass,
  ResidencyUsage,
} from '../api/types';

/** "GPU 0 — NVIDIA RTX 2000 Ada Generation" -> "GPU 0"; falls back to the raw id if a device is unknown. */
export function deviceShortLabel(deviceId: string | null, devices: ResidencyDevice[]): string {
  if (!deviceId) return '';
  const device = devices.find((candidate) => candidate.id === deviceId);
  if (!device) return deviceId;
  const [short] = device.label.split('—');
  return short.trim() || device.label;
}

/** One plain sentence for the model's current residency, per the mockup (ticket §13.2). */
export function formatModelStatus(model: ResidencyCatalogueModel, devices: ResidencyDevice[]): string {
  if (model.status === 'loading') return 'Loading…';
  if (model.status === 'unloading') return 'Unloading…';

  if (model.status === 'loaded' && model.residency) {
    const device = deviceShortLabel(model.residency.device, devices);
    const bytes = model.residency.bytes ?? model.size.bytes;
    const sizeText =
      bytes === null ? 'size unknown' : `${formatBytes(bytes)} ${model.residency.bytesSource === 'measured' ? 'measured' : 'estimated'}`;
    return device ? `Loaded · ${device} · ${sizeText}` : `Loaded · ${sizeText}`;
  }

  // not_loaded
  if (model.size.bytes === null) return 'Not loaded · size unknown';
  const prefix = model.size.source === 'measured' ? '' : '~';
  const loadPart = model.loadSeconds !== null ? ` · loads in ${Math.round(model.loadSeconds)} s` : '';
  return `Not loaded · ${prefix}${formatBytes(model.size.bytes)}${loadPart}`;
}

/** "4 agents · 2 tenants", singular-aware, or "No agent uses it" when nothing does. */
export function formatUsedBy(usage: ResidencyUsage): string {
  if (usage.agentCount === 0) return 'No agent uses it';
  const agents = `${usage.agentCount} agent${usage.agentCount === 1 ? '' : 's'}`;
  const tenants = `${usage.tenantCount} tenant${usage.tenantCount === 1 ? '' : 's'}`;
  return `${agents} · ${tenants}`;
}

const ROW_ACTION_ORDER: readonly ('load' | 'unload' | 'reload')[] = ['load', 'unload', 'reload'];
const ROW_ACTION_LABEL: Record<'load' | 'unload' | 'reload', string> = { load: 'Load', unload: 'Unload', reload: 'Reload…' };

/** The ONE primary row button (§13.2) — `edit_policy` never renders its own button; it lives in the drawer. */
export function primaryRowAction(actions: ResidencyAction[]): 'load' | 'unload' | 'reload' | null {
  return ROW_ACTION_ORDER.find((action) => actions.includes(action)) ?? null;
}

export function primaryRowActionLabel(action: 'load' | 'unload' | 'reload'): string {
  return ROW_ACTION_LABEL[action];
}

/** "5.4 of 16 GB used" — both figures forced to the SAME unit (GiB) so they read as one comparison. */
export function formatGpuUsage(usedBytes: number, totalBytes: number): string {
  const toGiB = (bytes: number) => bytes / 1024 ** 3;
  const round = (value: number) => Math.round(value * 10) / 10;
  const display = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return `${display(round(toGiB(usedBytes)))} of ${display(round(toGiB(totalBytes)))} GB used`;
}

const KEEP_POLICY_CLASS: Record<ResidencyKeepPolicyKind, ResidencyPolicyClass> = { always: 'PINNED', warm: 'WARM', on_demand: 'ON_DEMAND' };

/** Maps the plain-language radio choice to the write-side `ModelResidencyPolicy.class` enum. */
export function keepPolicyKindToClass(kind: ResidencyKeepPolicyKind): ResidencyPolicyClass {
  return KEEP_POLICY_CLASS[kind];
}

export const USE_ROLE_LABEL: Record<'primary' | 'fallback' | 'routing', string> = {
  primary: 'Primary',
  fallback: 'Fallback',
  routing: 'Routing policy',
};

const KNOWN_TASK_LABEL: Record<string, string> = {
  SPEECH_TO_TEXT: 'Speech-to-text',
  TEXT_GENERATION: 'Text generation',
  TEXT_TO_SPEECH: 'Text-to-speech',
  NAMED_ENTITY_RECOGNITION: 'Named entity recognition',
};

/** A consumer's `task` is an `AgentTask` (`SPEECH_TO_TEXT`) or an `AiRoutingPolicy` task key
 *  (`guardrail.judge`) — humanize whatever comes back rather than enumerating every possible value
 *  (no raw SCREAMING_CASE or dotted enums in the UI). */
export function humanizeTaskLabel(task: string): string {
  const known = KNOWN_TASK_LABEL[task];
  if (known) return known;
  const words = task.toLowerCase().split(/[._]/).filter(Boolean);
  if (words.length === 0) return task;
  return words.map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ');
}
