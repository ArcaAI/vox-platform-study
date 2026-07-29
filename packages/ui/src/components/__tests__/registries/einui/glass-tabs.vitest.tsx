import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GlassTabs, GlassTabsList, GlassTabsTrigger, GlassTabsContent } from '@/components/registries/einui/glass-tabs';

describe('GlassTabs', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <GlassTabs defaultValue="tab1">
        <GlassTabsList>
          <GlassTabsTrigger value="tab1">Tab 1</GlassTabsTrigger>
        </GlassTabsList>
        <GlassTabsContent value="tab1">Content</GlassTabsContent>
      </GlassTabs>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
