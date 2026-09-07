'use client';

/**
 * One glyph per node type (TASK-893 B1/§4.4) — the palette card's leading icon. Purely
 * decorative: the card's visible name and one-line purpose already carry the meaning in text,
 * so callers render this `aria-hidden` (rule 11 §7 — never color/icon alone).
 *
 * Only the 11 active `core.*` types (TASK-864) get a dedicated glyph. Every OTHER registry type
 * is `deprecated: true` today (README §2.7) and is removed wholesale in Phase 4 — growing this
 * map for a vocabulary on its way out is not worth the upkeep, so anything else falls back to a
 * generic node icon.
 */
import { createElement } from 'react';
import {
  IconArrowsExchange,
  IconBolt,
  IconDatabase,
  IconGitBranch,
  IconNotes,
  IconPlayerPlay,
  IconPuzzle,
  IconRepeat,
  IconRobot,
  IconSend,
  IconTags,
  IconUserCheck,
  type TablerIcon,
} from '@tabler/icons-react';

const NODE_TYPE_ICONS: Readonly<Record<string, TablerIcon>> = Object.freeze({
  'core.trigger': IconPlayerPlay,
  'core.agent': IconRobot,
  'core.classify': IconTags,
  'core.humanReview': IconUserCheck,
  'core.variable': IconDatabase,
  'core.condition': IconGitBranch,
  'core.loop': IconRepeat,
  'core.note': IconNotes,
  'core.output': IconSend,
  'core.data': IconArrowsExchange,
  'core.action': IconBolt,
});

/** The glyph for a registry node `type`. Falls back to a generic puzzle-piece icon. */
export function iconForNodeType(type: string): TablerIcon {
  return NODE_TYPE_ICONS[type] ?? IconPuzzle;
}

/**
 * The glyph as a COMPONENT. Callers render `<NodeTypeIcon type=… />` rather than hoisting
 * `iconForNodeType(type)` into a capitalized local: the lookup returns a stable reference from
 * the frozen map above, but a component-valued local is indistinguishable from one built during
 * render, so `react-hooks/static-components` refuses it — correctly, since that pattern remounts
 * the subtree whenever the identity does change.
 */
export function NodeTypeIcon({ type, className }: { type: string; className?: string }) {
  // `createElement` rather than `<Icon />`: every icon here is a stable reference out of the
  // frozen map above, but rendering a capitalized LOCAL is the shape `react-hooks/static-components`
  // refuses — it cannot distinguish a lookup from a component built inline, and the inline case
  // remounts the subtree on every render. Spelling the call out says which one this is.
  return createElement(iconForNodeType(type), { 'aria-hidden': 'true', className });
}
