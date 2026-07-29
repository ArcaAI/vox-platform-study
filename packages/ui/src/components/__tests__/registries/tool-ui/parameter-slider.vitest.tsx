import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ParameterSlider } from '../../../registries/tool-ui/parameter-slider';

describe('ParameterSlider', () => {
  it('renders without crashing', () => {
    render(<ParameterSlider id="1" sliders={[{ id: 'temp', label: 'Temperature', min: 0, max: 1, step: 0.1, value: 0.7 }]} />);
    expect(screen.getByText('Temperature')).toBeInTheDocument();
  });
});
