'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { useTheme } from 'next-themes';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

import type { SpecPlane } from '../types';

/**
 * The OpenAPI reference itself (Scalar), embedded natively in the console
 * (owner decision D-2).
 *
 * ## Why the spec arrives by URL rather than as a prop
 *
 * Scalar fetches `/api/docs/spec/<plane>` itself, and that route re-checks the
 * caller's ability on every request. Passing the document down from a server
 * component would instead bake it into the RSC payload — i.e. into the page
 * HTML — where it is cached by the browser and readable regardless of what the
 * user is still entitled to. The extra round-trip is the point.
 *
 * ## Why the client is off
 *
 * `hideClientButton` + `hideTestRequestButton` (owner decision D-3). Scalar's
 * built-in client would send real requests as the signed-in operator, against
 * the real gateway, with real tenant data behind it and no undo on a DELETE.
 * The reference is read-only until a sandbox tenant exists; the "copy as curl"
 * snippets remain, which is what a developer actually pastes anyway.
 */
export function ApiReference({ plane }: { plane: SpecPlane }) {
  const { resolvedTheme } = useTheme();

  // `resolvedTheme` is undefined until next-themes has read the DOM on the
  // client, which makes it the mount signal — no `useState` + `useEffect`
  // dance of our own. Rendering the skeleton until it resolves also avoids
  // mounting Scalar with the wrong palette and repainting it a frame later.
  if (!resolvedTheme) {
    return (
      <div className="flex h-full flex-col gap-3 p-1" data-testid="api-reference-skeleton">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-2xl" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <div className="mt-4 flex flex-1 gap-4">
          <Skeleton className="h-full w-56 shrink-0" />
          <Skeleton className="h-full flex-1" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full" data-slot="api-reference">
      <ApiReferenceReact
        configuration={{
          url: `/api/docs/spec/${plane}`,
          // `darkMode` seeds the initial state; `forceDarkModeState` is what
          // makes the console's theme actually win. Without the second one
          // Scalar restores its OWN persisted preference and the reference
          // renders light inside a dark console (and vice versa) — hiding the
          // toggle does not prevent that, it only hides the way back.
          darkMode: resolvedTheme === 'dark',
          forceDarkModeState: resolvedTheme === 'dark' ? 'dark' : 'light',
          hideClientButton: true,
          hideTestRequestButton: true,
          hideDarkModeToggle: true,
          // Scalar's developer-tools toolbar defaults to `'localhost'`, i.e. ON
          // in development, and carries Share / Deploy / Ask-AI actions that
          // push the document to Scalar's own cloud. That is a one-click egress
          // path for the full surface of a private healthcare API, sitting
          // inside an authenticated admin console — so it is `'never'`, in
          // every environment rather than only the ones where the default
          // happens to hide it.
          //
          // (`showToolbar` is the deprecated alias for this and is `Omit`ted
          // from the public config type — setting it does not type-check.)
          showDeveloperTools: 'never',
          // Same reasoning for the two remaining outbound affordances: `agent`
          // is the sidebar's Ask-AI chat (it ships document context to a model
          // endpoint we do not control) and `mcp` is the Generate/Connect MCP
          // server entry point. Both are off.
          agent: { disabled: true },
          mcp: { disabled: true },
          // The console owns the page frame; Scalar renders inside it.
          withDefaultFonts: false,
        }}
      />
    </div>
  );
}
