import { cn } from '@/lib/utils';
import { Separator } from '@arcaai/ui/separator';
import { TableOfContents, type TocSection } from './table-of-contents';
import { CtaCard, type CtaProps } from './cta-card';

export type { TocSection, CtaProps };

interface DocsLayoutProps {
  title: string;
  description: string;
  sections?: TocSection[];
  cta?: CtaProps;
  className?: string;
  children: React.ReactNode;
}

export function DocsLayout({ title, description, sections, cta, className, children }: DocsLayoutProps) {
  const hasRightSidebar = (sections && sections.length > 0) || cta;

  return (
    <div className="flex flex-1">
      <div
        className={cn(
          'mx-auto grid w-full gap-8 px-6 py-8 sm:px-10 lg:py-10',
          hasRightSidebar ? 'grid-cols-1 lg:grid-cols-[1fr_220px]' : 'grid-cols-1',
        )}
      >
        <article className="min-w-0">
          <header className="mb-4">
            <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
            <p className="text-muted-foreground mt-1.5 text-balance text-lg leading-relaxed">{description}</p>
          </header>
          <Separator className="mb-8" />
          <div className={cn('flex flex-col gap-8', className)}>{children}</div>
        </article>

        {hasRightSidebar && (
          <aside role="complementary" className="hidden lg:block">
            <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
              {sections && sections.length > 0 && <TableOfContents sections={sections} />}
              {cta && <CtaCard {...cta} />}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
