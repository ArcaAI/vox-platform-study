'use client';

import * as React from 'react';

import type { TimelineRendererProps } from '../types';
import { resolveRenderer } from './registry';

/** Composes multiple sub-content parts (audio + images + text + files). */
export function MixedRenderer({ content, ...rest }: TimelineRendererProps) {
  if (content.type !== 'mixed') return null;
  return (
    <div data-slot="timeline-mixed" className="space-y-3">
      {content.parts.map((part, index) => {
        const Renderer = resolveRenderer(part.type);
        return <React.Fragment key={index}>{Renderer({ ...rest, content: part })}</React.Fragment>;
      })}
    </div>
  );
}
