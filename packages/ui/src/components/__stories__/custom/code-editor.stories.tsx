import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { CodeEditor } from '../../custom/code-editor';

const SAMPLE = JSON.stringify(
  { model: 'gpt-4o', temperature: 0.2, tools: ['search', 'calc'], stream: true, fallback: null },
  null,
  2,
);

const meta = {
  title: 'Custom/CodeEditor',
  component: CodeEditor,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="h-[360px] w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

function Editable({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <CodeEditor value={value} onChange={setValue} aria-label="Configuration JSON" className="h-full" />;
}

/**
 * The editor surface is a FIXED dark colour in both light and dark themes
 * (artboard 5c). Toggle the Storybook theme — the chrome around it changes, the
 * editor does not. Syntax colours clear WCAG AA (>=4.5:1) on `--code-editor-bg`.
 */
export const Default: Story = {
  render: () => <Editable initial={SAMPLE} />,
};

/** Live validation surfaces the parse error with its line and column. */
export const Invalid: Story = {
  render: () => <Editable initial={'{\n  "model": "gpt-4o",\n  "temperature":\n}'} />,
};

/** Read-only mode drops the Format action but keeps validity and Copy. */
export const ReadOnly: Story = {
  render: () => <CodeEditor value={SAMPLE} aria-label="Configuration JSON" readOnly className="h-full" />,
};
