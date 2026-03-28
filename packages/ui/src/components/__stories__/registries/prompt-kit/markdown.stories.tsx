import type { Meta, StoryObj } from '@storybook/react-vite';

import { Markdown } from '../../../registries/prompt-kit/markdown';

const meta = {
  title: 'Registries/PromptKit/Markdown',
  component: Markdown,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'This is **bold** and *italic* text with `inline code`.',
  },
};

export const RichContent: Story = {
  args: {
    children: `# Heading 1
## Heading 2

- List item one
- List item two
- List item three

\`\`\`javascript
const example = "code block";
console.log(example);
\`\`\`

| Column A | Column B |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |`,
  },
};
