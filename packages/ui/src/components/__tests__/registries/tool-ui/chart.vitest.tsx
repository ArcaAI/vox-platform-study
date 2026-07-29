import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Chart } from '../../../registries/tool-ui/chart';

describe('Chart', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Chart id="1" type="bar" xKey="month" series={[{ key: 'value', label: 'Value' }]} data={[{ month: 'Jan', value: 100 }]} />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
