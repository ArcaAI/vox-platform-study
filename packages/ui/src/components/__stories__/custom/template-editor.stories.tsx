import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { TemplateEditor, type TemplateDiagnostic, type VariablePath } from '../../custom/template-editor';

const PATHS: VariablePath[] = [
  { path: 'context.patient.age', type: 'integer', required: true, phiClass: 'PHI', description: 'Age in whole years' },
  { path: 'context.patient.name', type: 'string', required: true, phiClass: 'PHI', description: 'Full name' },
  { path: 'context.visit.reason', type: 'string', required: false, phiClass: 'NON_PHI', description: 'Chief complaint' },
  { path: 'context.transcript', type: 'TEXT', required: true, phiClass: 'PHI', description: 'The consultation transcript' },
];

const declared = new Set(PATHS.map((entry) => entry.path));

function lint(content: string): TemplateDiagnostic[] {
  const out: TemplateDiagnostic[] = [];
  for (const match of content.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (!declared.has(match[1] as string)) {
      out.push({
        from: match.index ?? 0,
        to: (match.index ?? 0) + match[0].length,
        message: `\`${match[1]}\` is not declared by the bound schema.`,
        severity: 'error',
      });
    }
  }
  return out;
}

const meta = {
  title: 'Custom/TemplateEditor',
  component: TemplateEditor,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplateEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

function Editable({ initial, mode = 'template' }: { initial: string; mode?: 'template' | 'cel' }) {
  const [value, setValue] = useState(initial);
  return (
    <TemplateEditor
      value={value}
      onChange={setValue}
      paths={PATHS}
      lint={mode === 'template' ? lint : undefined}
      mode={mode}
      label={mode === 'cel' ? 'Condition' : 'Prompt'}
      minLines={mode === 'cel' ? 1 : 6}
    />
  );
}

/** Type `{{` to open the schema-aware completion list (type, required and PHI badges). */
export const Template: Story = {
  args: { value: 'Summarise the visit for a {{context.patient.age}}-year-old.\n\nReason: {{context.visit.reason}}', label: 'Prompt' },
  render: (args) => <Editable initial={args.value} />,
};

/** An undeclared path is squiggled and listed in the accessible summary under the editor. */
export const WithProblems: Story = {
  args: { value: 'Hello {{context.patient.nickname}}', label: 'Prompt' },
  render: (args) => <Editable initial={args.value} />,
};

/** CEL mode: completion opens after `context.` / `trigger.` / `nodes.`. */
export const Cel: Story = {
  args: { value: 'context.patient.age >= 18', label: 'Condition', mode: 'cel' },
  render: (args) => <Editable initial={args.value} mode="cel" />,
};

export const ReadOnly: Story = {
  args: { value: 'Fixed {{context.patient.age}}', label: 'Prompt', readOnly: true, paths: PATHS },
};
