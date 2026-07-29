import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SearchForm } from '../../../registries/blocks/search-form';
import { SidebarProvider, Sidebar } from '../../../shadcn/sidebar';

describe('SearchForm', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SearchForm />
        </Sidebar>
      </SidebarProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
