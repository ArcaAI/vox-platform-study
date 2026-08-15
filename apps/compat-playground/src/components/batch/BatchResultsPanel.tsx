import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui';
import { BatchAllResultsView } from './BatchAllResultsView';
import { BatchJobResult } from './BatchJobResult';

type ResultsView = 'selected' | 'all';

/**
 * Switches the results column between the existing master-detail single-file
 * view (`BatchJobResult`) and the new "all results" view that
 * lists every queued file's transcript at once.
 *
 * Defaults to `selected` — dropping ONE file (or clicking a queue row) reads
 * exactly as it did before this feature; "All results" is one click away for
 * scanning or exporting a bigger batch. Only one of the two is ever mounted,
 * so there is never a second Card header stacked on top of the single view's
 * own header (`11-ux-ui-principles.mdc` §2).
 */
export function BatchResultsPanel() {
  const [view, setView] = useState<ResultsView>('selected');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={view === 'selected' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={view === 'selected'}
          onClick={() => setView('selected')}
        >
          Selected file
        </Button>
        <Button type="button" variant={view === 'all' ? 'default' : 'outline'} size="sm" aria-pressed={view === 'all'} onClick={() => setView('all')}>
          All results
        </Button>
      </div>

      {view === 'selected' ? (
        <BatchJobResult />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All results</CardTitle>
            <CardDescription>Every queued file&apos;s transcript, in queue order — nothing is hidden while it&apos;s still running.</CardDescription>
          </CardHeader>
          <CardContent>
            <BatchAllResultsView />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
