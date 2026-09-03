/**
 * `DefinitionMetadataForm` — "Honesty gap: only the
 * `graph` field autosaves in this pass"). A short Dialog (rule 11 §1) over the name/description
 * pair — controlled state, no `react-hook-form` — that calls back on every
 * keystroke so the caller can drive the SAME debounced autosave the graph uses.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { DefinitionMetadataForm } from '../definition-metadata-form';

describe('DefinitionMetadataForm', () => {
  it('renders visible labels for name and description (never placeholder-only)', () => {
    render(
      <DefinitionMetadataForm open name="Discharge summary" description="" onOpenChange={vi.fn()} onNameChange={vi.fn()} onDescriptionChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/^Name/)).toBeTruthy();
    expect(screen.getByLabelText(/^Description/)).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    render(<DefinitionMetadataForm open={false} name="x" description="" onOpenChange={vi.fn()} onNameChange={vi.fn()} onDescriptionChange={vi.fn()} />);
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
  });

  it('editing the name field calls onNameChange with the new value on every keystroke', () => {
    const onNameChange = vi.fn();
    render(<DefinitionMetadataForm open name="Discharge" description="" onOpenChange={vi.fn()} onNameChange={onNameChange} onDescriptionChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Discharge v2' } });
    expect(onNameChange).toHaveBeenCalledWith('Discharge v2');
  });

  it('editing the description field calls onDescriptionChange', () => {
    const onDescriptionChange = vi.fn();
    render(
      <DefinitionMetadataForm open name="Discharge" description="" onOpenChange={vi.fn()} onNameChange={vi.fn()} onDescriptionChange={onDescriptionChange} />,
    );
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Summarizes the discharge note.' } });
    expect(onDescriptionChange).toHaveBeenCalledWith('Summarizes the discharge note.');
  });

  it('disables both fields when readOnly', () => {
    render(
      <DefinitionMetadataForm open readOnly name="Discharge" description="" onOpenChange={vi.fn()} onNameChange={vi.fn()} onDescriptionChange={vi.fn()} />,
    );
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^Description/) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('0 axe violations', async () => {
    const { container } = render(
      <DefinitionMetadataForm open name="Discharge summary" description="Summary" onOpenChange={vi.fn()} onNameChange={vi.fn()} onDescriptionChange={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
