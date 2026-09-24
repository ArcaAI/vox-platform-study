import { IconBulb } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { EmptyState } from '@/shared/state/empty-state';
import { formatRelativeTime } from '@/shared/format';
import type { ModelResidencyRecommendation } from '../api/types';

const REASON_LABEL: Record<ModelResidencyRecommendation['reason'], string> = {
  idle_ttl_expired: 'Idle TTL expired',
  promotion_rate: 'Sustained demand',
  live_path_pin: 'Live consultation path',
  make_room: 'Making room for another load',
  admission_rejected: 'Admission rejected',
};

const ACTION_LABEL: Record<ModelResidencyRecommendation['action'], string> = {
  load: 'Load',
  unload: 'Unload',
  pin: 'Pin',
  unpin: 'Unpin',
};

/**
 * The shadow-mode recommendation log (D-3, OD-1): what the policy engine
 * would have done. Read-only — shadow mode is a REVIEW step (7 days of data
 * before `residency.enforce` per OD-1), not a queue of actions to approve
 * here; an admin who agrees uses the Load/Unload/Pin row actions directly.
 */
export function RecommendationsPanel({ recommendations }: { recommendations: ModelResidencyRecommendation[] }) {
  return (
    <Card className="gap-3 p-4">
      <h2 className="text-sm font-medium">Recommendations (shadow log)</h2>
      {recommendations.length === 0 ? (
        <EmptyState
          icon={IconBulb}
          title="No recommendations yet"
          description="The policy engine logs what it would load, unload, pin or unpin here before anything is enforced."
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Recommendations">
          {recommendations.map((recommendation) => (
            <li key={recommendation.id} className="flex flex-wrap items-center gap-2 border-b pb-2 text-sm last:border-b-0 last:pb-0">
              <Badge variant={recommendation.applied ? 'default' : 'outline'}>{ACTION_LABEL[recommendation.action]}</Badge>
              <span className="font-mono text-xs">
                {recommendation.service}/{recommendation.modelRef}
              </span>
              <span className="text-muted-foreground text-xs">{REASON_LABEL[recommendation.reason]}</span>
              <span className="text-muted-foreground ml-auto text-xs">{formatRelativeTime(recommendation.at)}</span>
              {recommendation.mode === 'shadow' && !recommendation.applied ? <Badge variant="secondary">Not applied — shadow</Badge> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
