import type { Meta, StoryObj } from '@storybook/react-vite';

import { Mention, MentionContent, MentionInput, MentionItem } from '../../../registries/diceui/mention';

const meta = {
  title: 'Registries/DiceUI/Mention',
  component: Mention,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Mention>;

export default meta;
type Story = StoryObj<typeof meta>;

const users = ['Alice', 'Bob', 'Charlie'];

export const Default: Story = {
  render: () => (
    <Mention>
      <MentionInput placeholder="Type @ to mention..." />
      <MentionContent>
        {users.map((user) => (
          <MentionItem key={user} value={user}>
            {user}
          </MentionItem>
        ))}
      </MentionContent>
    </Mention>
  ),
};
