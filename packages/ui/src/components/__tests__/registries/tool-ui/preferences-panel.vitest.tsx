import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreferencesPanel } from '../../../registries/tool-ui/preferences-panel';

describe('PreferencesPanel', () => {
  it('renders without crashing', () => {
    render(<PreferencesPanel id="1" sections={[{ heading: 'General', items: [{ id: 'theme', label: 'Dark Mode', type: 'switch' }] }]} />);
    expect(screen.getByText('General')).toBeInTheDocument();
  });
});
