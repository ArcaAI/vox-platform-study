/**
 * Shared responsive class fragments (TASK-384; long tail + in-form touch
 * targets TASK-399). Kept at the app level so the shared `@arcaai/ui`
 * primitives stay untouched (they are also used by `ui-playground`).
 */

/**
 * Full-screen-on-mobile geometry shared by `DialogContent` and
 * `AlertDialogContent` (both center with `top/left 50% + translate -50%`, so a
 * full-width / full-height box under that translate covers the viewport).
 * Long bodies scroll inside via `overflow-y-auto`.
 */
const MOBILE_FULL_SCREEN_MODAL =
  'max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:overflow-y-auto';

/**
 * Grows in-form controls (`Input` / `Select` trigger) to a ≥44px touch target
 * on mobile (WCAG 2.2 AA · 2.5.8, TASK-399 / TASK-384 §7). Uses `min-h` so it
 * wins over the primitives' own `h-9` regardless of CSS order; `Textarea`
 * (`min-h-16`) is already tall enough.
 */
const MOBILE_FORM_CONTROLS = 'max-sm:[&_[data-slot=input]]:min-h-11 max-sm:[&_[data-slot=select-trigger]]:min-h-11';

/**
 * Makes a shadcn `DialogContent` fill the screen on mobile (`<640px`) while
 * preserving the desktop centered-modal layout, and bumps its in-form
 * `Input`/`Select` controls to ≥44px touch targets.
 *
 * Compose after the desktop width class, e.g.
 * `cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)`.
 */
export const MOBILE_DIALOG_CONTENT = `${MOBILE_FULL_SCREEN_MODAL} ${MOBILE_FORM_CONTROLS}`;

/**
 * `MOBILE_DIALOG_CONTENT` counterpart for `AlertDialogContent` (TASK-384 §7 —
 * the alert primitive needs its own fragment). Same full-screen geometry; no
 * form-control bump (confirms carry no inputs), and the footer's stacked
 * `flex-col-reverse` buttons land thumb-reachable at the bottom.
 */
export const MOBILE_ALERT_DIALOG_CONTENT = MOBILE_FULL_SCREEN_MODAL;

/**
 * Grows a `DialogFooter`'s direct action buttons to a ≥44px touch target on
 * mobile (WCAG 2.2 AA · 2.5.8). Use when the footer's buttons are direct
 * children; for nested footers use {@link MOBILE_DIALOG_FOOTER_DEEP}.
 */
export const MOBILE_DIALOG_FOOTER = 'max-sm:[&>button]:h-11';

/** Like {@link MOBILE_DIALOG_FOOTER} but targets buttons at any depth. */
export const MOBILE_DIALOG_FOOTER_DEEP = 'max-sm:[&_button]:h-11';
