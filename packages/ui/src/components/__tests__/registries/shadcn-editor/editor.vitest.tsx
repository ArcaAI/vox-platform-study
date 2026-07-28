import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Editor } from '../../../registries/shadcn-editor/editor';

describe('Editor', () => {
  it('renders without crashing', () => {
    const { container } = render(<Editor />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with onChange callback', () => {
    const { container } = render(<Editor onChange={() => {}} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with onSerializedChange callback', () => {
    const { container } = render(<Editor onSerializedChange={() => {}} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders the content editable area', () => {
    const { container } = render(<Editor />);
    const editable = container.querySelector('[contenteditable]');
    expect(editable).toBeTruthy();
  });
});
