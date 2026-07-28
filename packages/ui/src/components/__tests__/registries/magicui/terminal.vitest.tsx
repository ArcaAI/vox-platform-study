import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Terminal } from '../../../registries/magicui/terminal';

describe('Terminal', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Terminal>
        <span>$ echo hello</span>
      </Terminal>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
