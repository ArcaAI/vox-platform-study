import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { findDocKeyFromTarget } from '../lib/find-doc-key';
import { extractScopeFromUrl } from '../lib/scope-utils';
import { useDocPanelStore } from '../store/doc-panel-store';
import { DocPanel } from './doc-panel';

export function DocPanelRoot() {
  const setActiveDocKey = useDocPanelStore((state) => state.setActiveDocKey);
  const setActiveScope = useDocPanelStore((state) => state.setActiveScope);

  const { pathname } = useLocation();
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false });
  const docParam = (searchParams as Record<string, unknown>).doc as string | undefined;

  const canonicalScope = extractScopeFromUrl(pathname);

  useEffect(() => {
    setActiveScope(canonicalScope);
  }, [canonicalScope, setActiveScope]);

  const handleDocClick = useCallback(
    (event: Event) => {
      const key = findDocKeyFromTarget(event.target);
      if (!key) return;

      setActiveDocKey(key);
    },
    [setActiveDocKey],
  );

  useEffect(() => {
    document.addEventListener('click', handleDocClick, true);
    document.addEventListener('focusin', handleDocClick, true);

    return () => {
      document.removeEventListener('click', handleDocClick, true);
      document.removeEventListener('focusin', handleDocClick, true);
    };
  }, [handleDocClick]);

  useEffect(() => {
    const clearDocParam = () =>
      void navigate({
        search: ((prev: Record<string, unknown>) => {
          const { doc: _doc, ...rest } = prev;
          return rest;
        }) as never,
        replace: true,
      } as never);

    if (!docParam) return;

    if (!canonicalScope) {
      clearDocParam();
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(docParam);
    } catch {
      console.warn('[DocPanel] Malformed URI encoding in doc param — ignoring deep-link target');
      clearDocParam();
      return;
    }

    const colonIndex = decoded.indexOf(':');
    const targetScope = colonIndex === -1 ? decoded : decoded.slice(0, colonIndex);
    const docKey = colonIndex === -1 ? '' : decoded.slice(colonIndex + 1);

    if (!targetScope) {
      clearDocParam();
      return;
    }

    if (targetScope !== canonicalScope) {
      clearDocParam();
      return;
    }

    setActiveScope(targetScope);
    if (docKey) {
      setActiveDocKey(docKey);
    }

    clearDocParam();
  }, [docParam, canonicalScope, navigate, setActiveScope, setActiveDocKey]);

  return <DocPanel />;
}
