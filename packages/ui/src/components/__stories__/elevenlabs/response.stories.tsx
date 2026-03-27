import type { Meta, StoryObj } from '@storybook/react-vite';

import { Response } from '../../elevenlabs/response';

const meta: Meta<typeof Response> = {
  title: 'ElevenLabs/Response',
  component: Response,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Response>;

export const Default: Story = {
  args: {
    children: 'This is a simple response from the assistant.',
  },
};

export const WithMarkdown: Story = {
  args: {
    children: `# Hello World

This is a **bold** statement with some *italic* text.

- Item one
- Item two
- Item three`,
  },
};

export const ShortResponse: Story = {
  args: {
    children: 'OK',
  },
};

export const LongResponse: Story = {
  render: () => (
    <div className="max-w-md">
      <Response>
        {`Here is a detailed response that spans multiple paragraphs.

The first paragraph explains the context and background information that the user needs to understand.

The second paragraph provides the actual answer with specific details and recommendations.

Finally, the third paragraph summarizes the key points and suggests next steps.`}
      </Response>
    </div>
  ),
};

export const CustomClassName: Story = {
  render: () => (
    <div className="max-w-md">
      <Response className="text-sm text-muted-foreground">A response with custom styling applied via className.</Response>
    </div>
  ),
};
