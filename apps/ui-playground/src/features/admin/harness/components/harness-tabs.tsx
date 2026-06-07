import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';

/**
 * Route-based sub-navigation for the harness admin console (TASK-330 Phase 6).
 * Each tab is a real route under `/admin/harness/*` so deep-links and the
 * browser back/forward buttons work; the active tab is derived from the URL via
 * the router's `activeProps`.
 */
const TABS: { to: string; label: string }[] = [
  { to: '/admin/harness/overview', label: 'Overview' },
  { to: '/admin/harness/workflows', label: 'Workflows' },
  { to: '/admin/harness/policy', label: 'Policy' },
  { to: '/admin/harness/audit', label: 'Audit' },
  { to: '/admin/harness/evals', label: 'Evals' },
];

export function HarnessTabs() {
  return (
    <nav className="border-border mb-6 flex flex-wrap gap-1 border-b" aria-label="Harness sections">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className={cn(
            'text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium transition-colors',
            'focus-visible:ring-ring rounded-t-md focus-visible:outline-none focus-visible:ring-2',
          )}
          activeProps={{ className: 'border-primary text-foreground' }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
