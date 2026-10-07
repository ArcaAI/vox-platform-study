'use client';

import { useId, useState, type ReactNode } from 'react';
import { IconPrompt } from '@tabler/icons-react';
import { GUARDRAIL_JUDGE_CHECK_IDS, GUARDRAIL_JUDGE_LANE_CATEGORIES, type GuardrailJudgeCheckId } from '@arcaai/types';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { EmptyState } from '@/shared/state/empty-state';
import { useGuardrailPolicyKeys } from '../api/hooks';
import type { GuardrailPolicyKeyEntry, GuardrailPolicyKeyGroup } from '../api/types';
import { ControlErrorState } from './control-states';
import { DryRunPanel } from './dry-run-panel';
import { JudgePromptEditor, PlainCriteriaEditor } from './judge-prompt-editor';
import { NativeMappingEditor } from './native-mapping-editor';

const MEDICAL = 'medical_validation';
const LANE_LABEL: Record<string, string> = {
  injection_judge: 'Prompt-injection judge',
  unsafe_content_judge: 'Unsafe-content judge',
  clinical_safety_judge: 'Clinical-safety judge',
  leakage_judge: 'Leakage judge',
  [MEDICAL]: 'Medical-domain validation',
};

export function PromptsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-9 w-72" />
      {[0, 1, 2, 3, 4].map((section) => (
        <div key={section} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}

function findLane(groups: GuardrailPolicyKeyGroup[], lane: string): { entry: GuardrailPolicyKeyEntry | null; group: GuardrailPolicyKeyGroup | null } {
  for (const group of groups) {
    const entry = group.keys.find((key) => key.kind === 'criteria' && key.lane === lane);
    if (entry) return { entry, group };
  }
  return { entry: null, group: groups.find((group) => group.lane === lane) ?? null };
}

/**
 * Prompts (README §11.3 C, §12.2): per lane, the criteria editor for a `criteria_json` judge, or the
 * native-mapping editor when the lane elects a `qwen3guard_native` guard. The dry run sits under it and
 * picks up the unsaved draft of every editor on the page.
 */
export function PromptsTab() {
  const uid = useId();
  const query = useGuardrailPolicyKeys();
  const [lane, setLane] = useState<string>(GUARDRAIL_JUDGE_CHECK_IDS[0]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <PromptsSkeleton />;
  if (!query.data.catalogueAvailable) {
    return (
      <EmptyState
        icon={IconPrompt}
        title="Policy-key catalogue unavailable"
        description="The gateway could not read policy-keys.json, so no guardrail key is writable. Check the API image ships the artifact."
      />
    );
  }

  const groups = query.data.groups;

  function onDraftChange(key: string, value: string | null) {
    setDrafts((previous) => {
      const next = { ...previous };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  let body: ReactNode;
  if (lane === MEDICAL) {
    const entries = groups.flatMap((group) => group.keys).filter((key) => key.kind === 'criteria' && key.lane === null);
    body =
      entries.length === 0 ? (
        <EmptyState
          icon={IconPrompt}
          title="No medical criteria keys"
          description="The catalogue declares no criteria key for medical-domain validation."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {entries.map((entry) => (
            <PlainCriteriaEditor key={`${entry.key}:${entry.modelVersion}`} entry={entry} />
          ))}
        </div>
      );
  } else {
    const { entry, group } = findLane(groups, lane);
    if (group?.protocol === 'qwen3guard_native' && group.modelId) {
      body = <NativeMappingEditor key={group.modelId} modelId={group.modelId} modelSlug={group.modelSlug} />;
    } else if (entry) {
      body = (
        <JudgePromptEditor
          key={`${entry.key}:${entry.modelVersion}`}
          entry={entry}
          lane={lane}
          categories={GUARDRAIL_JUDGE_LANE_CATEGORIES[lane as GuardrailJudgeCheckId]}
          onDraftChange={onDraftChange}
        />
      );
    } else {
      body = (
        <EmptyState
          icon={IconPrompt}
          title="No criteria key for this lane"
          description="The catalogue declares no criteria prompt for this lane, or its model row is not elected yet."
        />
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-lane`}>Lane</Label>
        <NativeSelect id={`${uid}-lane`} value={lane} onChange={(event) => setLane(event.target.value)} className="max-w-sm">
          {[...GUARDRAIL_JUDGE_CHECK_IDS, MEDICAL].map((value) => (
            <NativeSelectOption key={value} value={value}>
              {LANE_LABEL[value] ?? value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <section aria-label={`${LANE_LABEL[lane] ?? lane} prompt`}>{body}</section>
      <DryRunPanel defaultLanes={[lane]} draftPolicy={drafts} />
    </div>
  );
}
