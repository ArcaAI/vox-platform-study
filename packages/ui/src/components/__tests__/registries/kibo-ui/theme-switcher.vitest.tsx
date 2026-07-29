import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeSwitcher } from '../../../registries/kibo-ui/theme-switcher';

describe('ThemeSwitcher', () => {
  it('renders without crashing', () => {
    const { container } = render(<ThemeSwitcher defaultValue="system" />);
    expect(container.firstChild).toBeTruthy();
  });
});
