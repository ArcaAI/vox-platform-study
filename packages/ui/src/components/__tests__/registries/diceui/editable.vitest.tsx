import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Editable, EditableArea, EditablePreview, EditableInput } from '@/components/registries/diceui/editable';

describe('Editable', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Editable defaultValue="test">
        <EditableArea>
          <EditablePreview />
          <EditableInput />
        </EditableArea>
      </Editable>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
