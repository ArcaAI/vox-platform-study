import { Button } from '@arcaai/ui/components/shadcn/button';
import type { RecapSectionView } from './recap-model';

/** The six keyed recap sections; each cited source jumps to the segment or attachment it came from. */
export function RecapPanel({ sections, onCitation }: { sections: RecapSectionView[]; onCitation: (itemId: string, versionNumber: number) => void }) {
  return (
    <section aria-label="Encounter recap" className="flex flex-col gap-3">
      {sections.map((section) => (
        <div key={section.key} data-recap-key={section.key} className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{section.label}</h3>
          {section.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing recorded</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {section.lines.map((line, index) => (
                <li key={index} className="text-sm">
                  <span>{line.text}</span>
                  {line.citations.map((citation) => (
                    <Button
                      key={`${citation.itemId}:${citation.versionNumber}`}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-1.5 align-baseline"
                      aria-label={`Go to ${citation.label}`}
                      onClick={() => onCitation(citation.itemId, citation.versionNumber)}
                    >
                      {citation.label}
                    </Button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
