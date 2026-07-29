import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatsDisplay } from '../../../registries/tool-ui/stats-display';

describe('StatsDisplay', () => {
  it('renders without crashing', () => {
    render(<StatsDisplay id="1" stats={[{ key: '1', label: 'Users', value: 1234 }]} />);
    expect(screen.getByText('Users')).toBeInTheDocument();
  });
});
