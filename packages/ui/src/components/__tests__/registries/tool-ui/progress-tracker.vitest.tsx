import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressTracker } from '../../../registries/tool-ui/progress-tracker';

describe('ProgressTracker', () => {
  it('renders without crashing', () => {
    render(<ProgressTracker id="1" steps={[{ id: '1', label: 'Step 1', status: 'completed' }]} />);
    expect(screen.getByText('Step 1')).toBeInTheDocument();
  });
});
