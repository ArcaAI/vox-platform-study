/**
 * Shared responsive class fragments (TASK-384). Kept at the app level so the
 * shared `@arcaai/ui` primitives stay untouched (they are also used by
 * `ui-playground`).
 */

/**
 * Makes a shadcn `DialogContent` fill the screen on mobile (`<640px`) while
 * preserving the desktop centered-modal layout. The shared `DialogContent`
 * centers itself with `translate -50%`, so a full-width / full-height box under
 * that translate covers the viewport. Long forms scroll inside via
 * `overflow-y-auto`.
 *
 * Compose after the desktop width class, e.g.
 * `cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)`.
 */
export const MOBILE_DIALOG_CONTENT =
    'max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:overflow-y-auto';

/**
 * Grows a `DialogFooter`'s direct action buttons to a ≥44px touch target on
 * mobile (WCAG 2.2 AA · 2.5.8). Use when the footer's buttons are direct
 * children; for nested footers use {@link MOBILE_DIALOG_FOOTER_DEEP}.
 */
export const MOBILE_DIALOG_FOOTER = 'max-sm:[&>button]:h-11';

/** Like {@link MOBILE_DIALOG_FOOTER} but targets buttons at any depth. */
export const MOBILE_DIALOG_FOOTER_DEEP = 'max-sm:[&_button]:h-11';
