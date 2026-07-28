import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Label } from '../../../registries/basecn/label';

describe('Label', () => {
  it('renders without crashing', () => {
    const { container } = render(<Label>Email</Label>);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders the label text', () => {
    const { getByText } = render(<Label>Username</Label>);
    expect(getByText('Username')).toBeTruthy();
  });
});
