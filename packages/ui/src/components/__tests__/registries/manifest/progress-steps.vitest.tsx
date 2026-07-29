import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProgressSteps } from '../../../registries/manifest/progress-steps';

describe('ProgressSteps', () => {
  it('renders without crashing', () => {
    const { container } = render(<ProgressSteps />);
    expect(container.firstChild).toBeTruthy();
  });
});
