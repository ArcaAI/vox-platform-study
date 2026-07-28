import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CoolMode } from '../../../registries/magicui/cool-mode';

describe('CoolMode', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CoolMode>
        <button>Click me</button>
      </CoolMode>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
