import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ColorPicker, ColorPickerSelection, ColorPickerHue } from '../../../registries/kibo-ui/color-picker';

describe('ColorPicker', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ColorPicker defaultValue="#3b82f6">
        <ColorPickerSelection className="h-40" />
        <ColorPickerHue />
      </ColorPicker>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
