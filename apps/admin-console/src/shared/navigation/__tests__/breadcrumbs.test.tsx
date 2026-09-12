import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useBreadcrumbStore } from '../breadcrumb-store';
import { Breadcrumbs } from '../breadcrumbs';

const usePathnameMock = vi.fn<() => string>(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

afterEach(() => {
  act(() => useBreadcrumbStore.setState({ trailing: null }));
});

describe('Breadcrumbs', () => {
  it('renders section and screen label for a top-level route', () => {
    usePathnameMock.mockReturnValue('/dashboard');
    renderWithProviders(<Breadcrumbs />);
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    // TASK-954 — /dashboard is a tier-20-29 (shared) screen: "Administration".
    expect(nav.textContent).toContain('Administration');
    expect(screen.getByText('Dashboard')).toBeTruthy();
  });

  it('links the parent and shows the resolved detail name from the store', () => {
    usePathnameMock.mockReturnValue('/tenants/t-123');
    act(() => useBreadcrumbStore.setState({ trailing: 'Sunrise Medical Group' }));
    renderWithProviders(<Breadcrumbs />);

    const parentLink = screen.getByRole('link', { name: 'Tenants' });
    expect(parentLink.getAttribute('href')).toBe('/tenants');
    expect(screen.getByText('Sunrise Medical Group')).toBeTruthy();
  });

  it('falls back to the raw segment before the detail name resolves', () => {
    usePathnameMock.mockReturnValue('/tenants/t-123');
    renderWithProviders(<Breadcrumbs />);
    expect(screen.getByText('t-123')).toBeTruthy();
  });

  it('prefers the longest route match (/tenants/storage over /tenants)', () => {
    usePathnameMock.mockReturnValue('/tenants/storage');
    renderWithProviders(<Breadcrumbs />);
    expect(screen.getByText('Tenant storage')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Tenants' })).toBeNull();
  });
});
