'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { AiModel } from '../api/types';

/**
 * Which of the two weight-loading modes a model's `sourceUri`/`localPath`
 * currently resolve to. `localPath` wins whenever both are set — mirrors the
 * precedence documented on `UpdateModelRequest.localPath` (every service
 * resolver dispatches on `sourceUri`'s scheme ONLY when `localPath` is unset
 * or missing on disk).
 */
export type WeightSourceMode = 'mount' | 's3-uri' | 'hub-id' | 'none';

export function weightSourceMode(model: Pick<AiModel, 'sourceUri' | 'localPath'>): WeightSourceMode {
  if (model.localPath && model.localPath.trim() !== '') return 'mount';
  const uri = model.sourceUri?.trim() ?? '';
  if (uri === '') return 'none';
  if (uri.toLowerCase().startsWith('s3://')) return 's3-uri';
  return 'hub-id';
}

/** Never color-only (rule 11 §10): each mode carries its own label + role. */
const WEIGHT_SOURCE_META: Record<WeightSourceMode, { label: string; role: StatusColorRole }> = {
  mount: { label: 'Mounted', role: 'primary' },
  's3-uri': { label: 'S3 URI', role: 'info' },
  'hub-id': { label: 'Hub ID', role: 'neutral' },
  none: { label: 'No source', role: 'warning' },
};

/** At-a-glance chip for "which loading mode is configured" (frame 15 catalog view). */
export function WeightSourceBadge({ model }: { model: Pick<AiModel, 'sourceUri' | 'localPath'> }) {
  const mode = weightSourceMode(model);
  const meta = WEIGHT_SOURCE_META[mode];
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
