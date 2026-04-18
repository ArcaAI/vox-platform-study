import { Main } from '@/components/layout/main';
import { ServiceStatusBar } from '@/components/layout/service-status-bar';
import { cn } from '@/lib/utils';

type ColumnLayout = 'one' | 'two' | 'three';

interface PlaygroundLayoutProps {
  title: string;
  description?: string;
  columns?: ColumnLayout;
  headerAction?: React.ReactNode;
  showServiceStatus?: boolean;
  children: React.ReactNode;
}

const columnClasses: Record<ColumnLayout, string> = {
  one: 'grid-cols-1',
  two: 'grid-cols-1 lg:grid-cols-2',
  three: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
};

export function PlaygroundLayout({ title, description, columns = 'one', headerAction, showServiceStatus = true, children }: PlaygroundLayoutProps) {
  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
              {description && <p className="text-muted-foreground">{description}</p>}
            </div>
            <div className="flex items-center gap-2">{headerAction}</div>
          </div>

          <div className="space-y-6 pb-4">
            {showServiceStatus && <ServiceStatusBar />}

            <div className={cn('grid gap-6 *:min-w-0', columnClasses[columns])}>{children}</div>
          </div>
        </div>
      </div>
    </Main>
  );
}
