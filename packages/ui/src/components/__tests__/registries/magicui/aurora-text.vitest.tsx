import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AuroraText } from '../../../registries/magicui/aurora-text';

describe('AuroraText', () => {
  it('renders without crashing', () => {
    const { container } = render(<AuroraText>Test</AuroraText>);
    expect(container.firstChild).toBeTruthy();
  });
});
