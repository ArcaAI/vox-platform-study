import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OptionList } from '../../../registries/tool-ui/option-list';

describe('OptionList', () => {
  it('renders without crashing', () => {
    render(
      <OptionList
        id="1"
        options={[
          { id: '1', label: 'Option A' },
          { id: '2', label: 'Option B' },
        ]}
      />,
    );
    expect(screen.getByText('Option A')).toBeInTheDocument();
  });
});
