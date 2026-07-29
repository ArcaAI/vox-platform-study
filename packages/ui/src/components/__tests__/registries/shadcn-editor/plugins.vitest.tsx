import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { Plugins } from '../../../registries/shadcn-editor/plugins';
import { nodes } from '../../../registries/shadcn-editor/nodes';
import { editorTheme } from '../../../registries/shadcn-editor/themes/editor-theme';

const editorConfig = {
  namespace: 'PluginsTest',
  theme: editorTheme,
  nodes,
  onError: (error: Error) => console.error(error),
};

const renderWithComposer = (ui: React.ReactElement) => render(<LexicalComposer initialConfig={editorConfig}>{ui}</LexicalComposer>);

describe('Plugins', () => {
  it('renders without crashing', () => {
    const { container } = renderWithComposer(<Plugins />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders a content editable element', () => {
    const { container } = renderWithComposer(<Plugins />);
    const editable = container.querySelector('[contenteditable]');
    expect(editable).toBeTruthy();
  });

  it('renders the placeholder text', () => {
    const { container } = renderWithComposer(<Plugins />);
    expect(container.textContent).toContain('Start typing ...');
  });
});
