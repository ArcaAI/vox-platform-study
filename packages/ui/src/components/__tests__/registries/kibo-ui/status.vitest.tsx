import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Status, StatusIndicator, StatusLabel } from '../../../registries/kibo-ui/status';

describe('Status', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Status status="online">
        <StatusIndicator />
        <StatusLabel />
      </Status>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
