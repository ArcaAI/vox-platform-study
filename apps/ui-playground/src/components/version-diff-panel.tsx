import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';

import { DiffStatsBar, TextDiffViewer } from '@/components/text-diff-viewer';

export interface VersionMeta {
  versionNumber: number;
  date?: string | null;
  changeReason?: string | null;
}

export interface DiffSection {
  label: string;
  oldText: string;
  newText: string;
}

export interface DiffAttribute {
  key: string;
  label: string;
  oldValue: string;
  newValue: string;
}

interface VersionDiffPanelProps {
  left: VersionMeta;
  right: VersionMeta;
  sections: DiffSection[];
  attributes?: DiffAttribute[];
  formatDate?: (date: string) => string;
  contentClassName?: string;
}

function defaultFormatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function VersionDiffPanel({ left, right, sections, attributes, formatDate = defaultFormatDate, contentClassName }: VersionDiffPanelProps) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Version metadata side-by-side */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline">v{left.versionNumber}</Badge>
            <span className="text-muted-foreground text-xs">{left.date ? formatDate(left.date) : '—'}</span>
          </div>
          {left.changeReason && <p className="text-muted-foreground mt-1 text-xs italic">{left.changeReason}</p>}
        </div>
        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="default">v{right.versionNumber}</Badge>
            <span className="text-muted-foreground text-xs">{right.date ? formatDate(right.date) : '—'}</span>
          </div>
          {right.changeReason && <p className="text-muted-foreground mt-1 text-xs italic">{right.changeReason}</p>}
        </div>
      </div>

      {/* Text sections with inline diff */}
      {sections.map((section) => (
        <div key={section.label} className="rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{section.label}</h4>
            <DiffStatsBar oldText={section.oldText} newText={section.newText} />
          </div>
          <Separator className="mb-3" />
          {section.oldText || section.newText ? (
            <TextDiffViewer oldText={section.oldText} newText={section.newText} className={contentClassName ?? 'text-sm'} />
          ) : (
            <p className={`text-muted-foreground ${contentClassName ?? 'text-sm'}`}>No content in either version.</p>
          )}
        </div>
      ))}

      {/* Optional attribute grid */}
      {attributes && attributes.length > 0 && (
        <div className="rounded-lg border p-3">
          <h4 className="mb-3 text-sm font-semibold">Attributes</h4>
          <div className="grid gap-2 md:grid-cols-2">
            {attributes.map((attr) => {
              const changed = attr.oldValue !== attr.newValue;
              return (
                <div key={attr.key} className="rounded-md border p-2">
                  <p className="text-muted-foreground mb-1 text-xs font-medium">{attr.label}</p>
                  {changed ? (
                    <TextDiffViewer oldText={attr.oldValue} newText={attr.newValue} className="text-xs" />
                  ) : (
                    <p className="text-xs font-medium">{attr.newValue || '—'}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
