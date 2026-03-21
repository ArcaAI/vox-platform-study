import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface TocSection {
    id: string;
    title: string;
    level?: 2 | 3;
}

interface TableOfContentsProps {
    sections: TocSection[];
}

export function TableOfContents({ sections }: TableOfContentsProps) {
    const [activeId, setActiveId] = useState<string>('');
    const observerRef = useRef<IntersectionObserver | null>(null);

    useEffect(() => {
        if (sections.length === 0) return;

        const callback: IntersectionObserverCallback = (entries) => {
            const visible = entries.find((e) => e.isIntersecting);
            if (visible?.target.id) {
                setActiveId(visible.target.id);
            }
        };

        observerRef.current = new IntersectionObserver(callback, {
            rootMargin: '-80px 0px -60% 0px',
            threshold: 0,
        });

        for (const section of sections) {
            const el = document.getElementById(section.id);
            if (el) observerRef.current.observe(el);
        }

        return () => observerRef.current?.disconnect();
    }, [sections]);

    if (sections.length === 0) return null;

    return (
        <nav aria-label="Table of contents">
            <h4 className="text-sm font-semibold">On This Page</h4>
            <ul className="mt-2 flex flex-col gap-1">
                {sections.map((section) => {
                    const isH3 = (section.level ?? 2) === 3;
                    const isActive = activeId === section.id;

                    return (
                        <li key={section.id}>
                            <a
                                href={`#${section.id}`}
                                className={cn(
                                    'text-muted-foreground hover:text-foreground block text-sm transition-colors',
                                    isH3 && 'pl-4',
                                    isActive && 'text-foreground font-medium',
                                )}
                            >
                                {section.title}
                            </a>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
