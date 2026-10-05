/**
 * The Studio's CEL fields are `TemplateEditor`s in CEL mode: completion after `trigger.` /
 * `context.` / `nodes.` over the workflow's schema paths and graph references, with the existing
 * bracket check and quick-insert chips kept as the single-pointer alternative.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTemplateEditorValue, templateEditorValue } from '@/test/template-editor';
import { CelExpressionField } from '../cel-expression-field';

const PATHS = [{ path: 'trigger.intake.age', type: 'integer', required: true, phiClass: 'PHI', description: null, deprecated: false }];

afterEach(() => cleanup());

describe('CelExpressionField — TemplateEditor (CEL mode)', () => {
  it('is a labelled CEL editor that writes through onChange and keeps its chips', () => {
    const onChange = vi.fn();
    render(<CelExpressionField id="when" label="When" value="trigger.intake.age > 1" onChange={onChange} references={['vars.count']} paths={PATHS} />);
    const editor = screen.getByRole('textbox', { name: 'When' });
    expect(editor.closest('[data-slot="template-editor"]')?.getAttribute('data-mode')).toBe('cel');
    expect(templateEditorValue(editor)).toBe('trigger.intake.age > 1');
    setTemplateEditorValue(editor, 'trigger.intake.age > 2');
    expect(onChange).toHaveBeenLastCalledWith('trigger.intake.age > 2');
    fireEvent.click(screen.getByRole('button', { name: 'vars.count' }));
    expect(onChange).toHaveBeenLastCalledWith('trigger.intake.age > 1 vars.count');
  });

  it('0 axe violations', async () => {
    const { container } = render(<CelExpressionField id="when" label="When" value="(a" onChange={vi.fn()} paths={PATHS} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
