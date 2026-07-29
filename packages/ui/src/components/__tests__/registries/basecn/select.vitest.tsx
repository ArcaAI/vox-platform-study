import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectPositioner } from '../../../registries/basecn/select';

describe('Select', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectPositioner>
          <SelectContent>
            <SelectItem value="a">Option A</SelectItem>
            <SelectItem value="b">Option B</SelectItem>
          </SelectContent>
        </SelectPositioner>
      </Select>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
