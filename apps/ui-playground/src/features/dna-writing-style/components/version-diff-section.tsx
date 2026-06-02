import { useEffect, useMemo, useState } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { GitCompare } from 'lucide-react';

import { VersionDiffPanel } from '@/components/version-diff-panel';
import type { DnaStyleVersion } from '../api/dna-writing-styles';

const ATTR_KEYS = ['tone', 'vocabulary', 'structure', 'formality', 'sentenceLength', 'medicalTermUsage', 'abbreviationStyle'] as const;
const ATTR_LABEL: Record<string, string> = {
  tone: 'Tone',
  vocabulary: 'Vocabulary',
  structure: 'Structure',
  formality: 'Formality',
  sentenceLength: 'Sentence Length',
  medicalTermUsage: 'Medical Terms',
  abbreviationStyle: 'Abbreviations',
};

export interface VersionDiffSectionProps {
  versions: DnaStyleVersion[];
  isLoading: boolean;
}

/**
 * TASK-329 P5 — Diff two DNA report versions side-by-side.
 *
 * Reuses the shared `VersionDiffPanel`. Two pickers default to the two most
 * recent versions; the panel lays out the style-description text diff plus a
 * per-attribute comparison grid.
 */
export function VersionDiffSection({ versions, isLoading }: VersionDiffSectionProps) {
  const sorted = useMemo(() => [...versions].sort((a, b) => b.versionNumber - a.versionNumber), [versions]);

  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  // Default to comparing the two most recent versions whenever the set changes.
  useEffect(() => {
    if (sorted.length >= 2) {
      setRightId((cur) => (cur && sorted.some((v) => v.id === cur) ? cur : sorted[0]!.id));
      setLeftId((cur) => (cur && sorted.some((v) => v.id === cur) ? cur : sorted[1]!.id));
    } else {
      setLeftId(null);
      setRightId(null);
    }
  }, [sorted]);

  const left = sorted.find((v) => v.id === leftId) ?? null;
  const right = sorted.find((v) => v.id === rightId) ?? null;

  return (
    <Card data-doc="dna-version-diff">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompare className="size-4" aria-hidden="true" />
          Compare Versions
        </CardTitle>
        <CardDescription>Diff two versions to see how the writing style evolved.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : sorted.length < 2 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <GitCompare className="text-muted-foreground/50 mb-2 size-7" aria-hidden="true" />
            <p className="text-muted-foreground text-sm">At least two versions are needed to compare.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground font-medium">Base (older)</span>
                <select
                  className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
                  value={leftId ?? ''}
                  onChange={(e) => setLeftId(e.target.value)}
                  aria-label="Base version"
                >
                  {sorted.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground font-medium">Compare (newer)</span>
                <select
                  className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
                  value={rightId ?? ''}
                  onChange={(e) => setRightId(e.target.value)}
                  aria-label="Compare version"
                >
                  {sorted.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {left && right && (
              <VersionDiffPanel
                left={{ versionNumber: left.versionNumber, date: left.createdAt, changeReason: left.changeReason }}
                right={{ versionNumber: right.versionNumber, date: right.createdAt, changeReason: right.changeReason }}
                sections={[{ label: 'Style Description', oldText: left.styleText || '', newText: right.styleText || '' }]}
                attributes={ATTR_KEYS.map((key) => ({
                  key,
                  label: ATTR_LABEL[key],
                  oldValue: String(left.reportData?.[key] ?? ''),
                  newValue: String(right.reportData?.[key] ?? ''),
                }))}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
