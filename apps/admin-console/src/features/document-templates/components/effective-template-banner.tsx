'use client';

/**
 * What generation actually produces for this tenant RIGHT NOW.
 *
 * This banner exists because `resolveForGeneration` fails OPEN: when no
 * template resolves, a live consultation keeps working and quietly produces the
 * platform SOAP shape. That is the right runtime behaviour and the wrong thing
 * to leave invisible in an authoring screen — an admin who publishes a
 * discharge summary but forgets to mark it default, or leaves it on DRAFT, gets
 * no error anywhere; they just keep getting SOAP notes and no explanation.
 *
 * So the fallback is reported as an ordinary, named state (`Alert` default
 * variant, not `destructive`) with the reason spelled out and the fix stated —
 * never as an error, because an unconfigured tenant has done nothing wrong.
 *
 * That framing has to hold for a screen reader too, which is why both branches
 * override the primitive's `role`. `Alert` hardcodes `role="alert"` — an
 * ASSERTIVE live region, which interrupts whatever the user is reading the
 * moment it mounts. Correct for the publish rejections elsewhere in this
 * feature (an error, caused by an action the user just took); wrong here, where
 * the banner is a standing description of current state rendered on every
 * visit. `role="status"` is the polite equivalent (WCAG 4.1.3), and it is what
 * keeps the assistive-technology reading of this banner consistent with its
 * visual one: information, not an alarm.
 */

import { IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { PLATFORM_FALLBACK_SECTION_TITLES } from '../api/types';
import type { EffectiveTemplate, EffectiveTemplateReason } from '../lib/effective-template';

const FALLBACK_EXPLANATION: Record<EffectiveTemplateReason, string> = {
  NO_TEMPLATES: 'This tenant has not authored a document template yet.',
  NO_DEFAULT: 'None of this tenant’s templates is marked as the default, and a generation node that names no template resolves the default only.',
  NEVER_PUBLISHED: 'The default template has never been published, so it has no version to serve. Publish a shape from its Shape tab.',
  NOT_SERVABLE_STATUS: 'The default template has a published version but its status is DRAFT, so it is not served. Move it to PUBLISHED or APPROVED.',
};

export function EffectiveTemplateBanner({ effective }: { effective: EffectiveTemplate }) {
  if (effective.kind === 'SERVING' && effective.template) {
    return (
      <Alert role="status">
        <IconCircleCheck aria-hidden />
        <AlertTitle>
          Generating “{effective.template.name}” (v{effective.versionNumber})
        </AlertTitle>
        <AlertDescription>
          <p>
            A generation node that names no template resolves this one, from the pinned version — never simply the latest published one.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert role="status">
      <IconInfoCircle aria-hidden />
      <AlertTitle>Generating the platform SOAP Note shape</AlertTitle>
      <AlertDescription>
        <p>{effective.reason ? FALLBACK_EXPLANATION[effective.reason] : null}</p>
        <p>
          Generation never fails for want of a template — it falls back to the platform shape ({PLATFORM_FALLBACK_SECTION_TITLES.join(', ')}), so
          consultations keep working. Nothing is broken; this is what is being produced today.
        </p>
      </AlertDescription>
    </Alert>
  );
}
