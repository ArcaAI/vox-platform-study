import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '../../../registries/basecn/dialog';

describe('Dialog', () => {
  it('renders trigger without crashing', () => {
    const { container } = render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
      </Dialog>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
