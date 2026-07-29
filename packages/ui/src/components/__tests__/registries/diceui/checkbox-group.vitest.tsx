import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CheckboxGroup, CheckboxGroupList, CheckboxGroupItem } from '@/components/registries/diceui/checkbox-group';

describe('CheckboxGroup', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CheckboxGroup>
        <CheckboxGroupList>
          <CheckboxGroupItem value="a">A</CheckboxGroupItem>
        </CheckboxGroupList>
      </CheckboxGroup>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
