import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Combobox, ComboboxAnchor, ComboboxInput } from '@/components/registries/diceui/combobox';

describe('Combobox', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Combobox>
        <ComboboxAnchor>
          <ComboboxInput placeholder="Search" />
        </ComboboxAnchor>
      </Combobox>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
