import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Pill } from '../../../registries/kibo-ui/pill';

describe('Pill', () => {
  it('renders without crashing', () => {
    const { container } = render(<Pill>Test Pill</Pill>);
    expect(container.firstChild).toBeTruthy();
  });
});
