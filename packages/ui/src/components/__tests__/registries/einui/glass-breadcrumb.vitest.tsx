import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GlassBreadcrumb, GlassBreadcrumbList, GlassBreadcrumbItem, GlassBreadcrumbPage } from '@/components/registries/einui/glass-breadcrumb';

describe('GlassBreadcrumb', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <GlassBreadcrumb>
        <GlassBreadcrumbList>
          <GlassBreadcrumbItem>
            <GlassBreadcrumbPage>Home</GlassBreadcrumbPage>
          </GlassBreadcrumbItem>
        </GlassBreadcrumbList>
      </GlassBreadcrumb>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
