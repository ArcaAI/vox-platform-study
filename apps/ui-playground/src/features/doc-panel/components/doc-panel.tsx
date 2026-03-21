import { cn } from '@/lib/utils';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { FileText, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { loadRegistry } from '../registry';
import { useDocPanelStore } from '../store/doc-panel-store';
import type { DocRegistry } from '../types';
import { DocContent } from './doc-content';

interface DocPanelProps {
  className?: string;
}

function clampPanelWidth(width: number): number {
  const minWidth = 320;
  const sidebarWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 0;
  const maxWidth = Math.max(minWidth, Math.round(window.innerWidth - sidebarWidth));
  return Math.max(minWidth, Math.min(maxWidth, width));
}

export function DocPanel({ className }: DocPanelProps) {
  const { isOpen, isLoading, activeDocKey, activeScope, setLoading, setOpen } = useDocPanelStore();

  const [registry, setRegistry] = useState<DocRegistry | null>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [hasScrollShadow, setHasScrollShadow] = useState(false);

  useEffect(() => {
    if (!activeScope) {
      setRegistry(null);
      setLoading(false);
      return;
    }

    let isCancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const loaded = await loadRegistry(activeScope);
        if (!isCancelled) {
          setRegistry(loaded);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error(`[DocPanel] Failed to load docs for feature "${activeScope}"`, error);
          setRegistry(null);
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      isCancelled = true;
    };
  }, [activeScope, setLoading]);

  useEffect(() => {
    if (!isOpen || panelWidth !== null) return;
    setPanelWidth(Math.round(window.innerWidth * 0.34));
  }, [isOpen, panelWidth]);

  useEffect(() => {
    if (isOpen) {
      const frame = requestAnimationFrame(() => setIsVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setIsVisible(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, setOpen]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      setHasScrollShadow(container.scrollTop > 0);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isOpen]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;

      const deltaX = dragState.startX - event.clientX;
      const nextWidth = clampPanelWidth(dragState.startWidth + deltaX);

      setPanelWidth(nextWidth);
    };

    const onPointerUp = () => {
      dragStateRef.current = null;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
  }, []);

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    dragStateRef.current = {
      startX: event.clientX,
      startWidth: panelWidth ?? Math.round(window.innerWidth * 0.34),
    };

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentWidth = panelWidth ?? Math.round(window.innerWidth * 0.34);
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setPanelWidth(clampPanelWidth(currentWidth + 24));
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setPanelWidth(clampPanelWidth(currentWidth - 24));
    }
  };

  const allEntries = useMemo(() => {
    if (!registry) return [];
    return Object.entries(registry).map(([key, value]) => ({ key, entry: value }));
  }, [registry]);

  useEffect(() => {
    if (!isVisible || !activeDocKey) return;

    const frame = requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const activeEl = container.querySelector(`[data-doc="${CSS.escape(activeDocKey)}"]`);
      activeEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeDocKey, isVisible, allEntries]);

  if (!isOpen) return null;

  return (
    <section
      id="doc-panel"
      aria-labelledby="doc-panel-title"
      className={cn(
        'bg-background fixed top-16 right-0 bottom-0 z-30 flex w-[36vw] min-w-85 flex-col overflow-hidden border-l shadow-lg',
        'transition-transform duration-300 ease-out',
        isVisible ? 'translate-x-0' : 'translate-x-full',
        className,
      )}
      style={
        panelWidth
          ? {
              width: `${panelWidth}px`,
              maxWidth: 'calc(100vw - var(--sidebar-width, 0px))',
            }
          : { maxWidth: 'calc(100vw - var(--sidebar-width, 0px))' }
      }
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize documentation panel"
        tabIndex={0}
        onPointerDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
        className="group absolute inset-y-0 left-0 z-10 flex w-4 cursor-ew-resize items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      ></div>

      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 id="doc-panel-title" className="text-lg font-semibold">
          Documentation
        </h2>
        <div className="ml-auto">
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setOpen(false)} aria-label="Close documentation panel">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3', hasScrollShadow && 'shadow-[inset_0_6px_6px_-6px_rgba(0,0,0,0.1)]')}
      >
        {isLoading ? (
          <div role="status">
            <p className="sr-only">Loading documentation</p>
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="mt-2 h-4 w-1/2" />
            <div className="mt-4 flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          </div>
        ) : !registry ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="text-muted-foreground/50 size-10" />
            <h3 className="mt-3 text-sm font-semibold">No Documentation</h3>
            <p className="text-muted-foreground mt-1 max-w-60 text-xs leading-relaxed">No documentation is available for this section yet.</p>
          </div>
        ) : allEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="text-muted-foreground/50 size-10" />
            <h3 className="mt-3 text-sm font-semibold">Coming Soon</h3>
            <p className="text-muted-foreground mt-1 max-w-60 text-xs leading-relaxed">Documentation for this section is being prepared.</p>
          </div>
        ) : (
          <div className="flex flex-col pb-4">
            {allEntries.map(({ key, entry: docEntry }) => {
              const isActive = activeDocKey === key;
              return (
                <article
                  key={key}
                  data-doc={key}
                  className={cn(
                    '-scroll-mt-3 py-4 first:pt-0 last:border-b-0',
                    'transition-colors duration-300',
                    isActive ? 'border-l-primary' : 'border-l-transparent',
                  )}
                >
                  <DocContent content={docEntry.content} />
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
