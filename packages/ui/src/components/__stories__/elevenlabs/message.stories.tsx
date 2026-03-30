import type { Meta, StoryObj } from '@storybook/react-vite';

import { Message, MessageContent, MessageAvatar } from '../../elevenlabs/message';

const meta: Meta<typeof Message> = {
  title: 'ElevenLabs/Message',
  component: Message,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    from: {
      control: 'select',
      options: ['user', 'assistant'],
      description: 'Who sent the message',
    },
  },
};

export default meta;
type Story = StoryObj<typeof Message>;

export const UserMessage: Story = {
  render: () => (
    <div className="w-[500px]">
      <Message from="user">
        <MessageContent>Hello, how can I help you today?</MessageContent>
      </Message>
    </div>
  ),
};

export const AssistantMessage: Story = {
  render: () => (
    <div className="w-[500px]">
      <Message from="assistant">
        <MessageContent>I can help you with a variety of tasks. What would you like to know?</MessageContent>
      </Message>
    </div>
  ),
};

export const WithAvatar: Story = {
  render: () => (
    <div className="w-[500px] space-y-2">
      <Message from="user">
        <MessageAvatar src="https://github.com/shadcn.png" name="User" />
        <MessageContent>What is the weather today?</MessageContent>
      </Message>
      <Message from="assistant">
        <MessageAvatar src="https://github.com/vercel.png" name="AI" />
        <MessageContent>The weather is sunny with a high of 72°F.</MessageContent>
      </Message>
    </div>
  ),
};

export const ContainedVariant: Story = {
  render: () => (
    <div className="w-[500px] space-y-2">
      <Message from="user">
        <MessageContent variant="contained">This is a contained message from the user.</MessageContent>
      </Message>
      <Message from="assistant">
        <MessageContent variant="contained">This is a contained message from the assistant.</MessageContent>
      </Message>
    </div>
  ),
};

export const FlatVariant: Story = {
  render: () => (
    <div className="w-[500px] space-y-2">
      <Message from="user">
        <MessageContent variant="flat">This is a flat message from the user.</MessageContent>
      </Message>
      <Message from="assistant">
        <MessageContent variant="flat">This is a flat message from the assistant.</MessageContent>
      </Message>
    </div>
  ),
};

export const LongMessage: Story = {
  render: () => (
    <div className="w-[500px]">
      <Message from="assistant">
        <MessageAvatar src="https://github.com/vercel.png" name="AI" />
        <MessageContent>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim
          veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in
          voluptate velit esse cillum dolore eu fugiat nulla pariatur.
        </MessageContent>
      </Message>
    </div>
  ),
};
