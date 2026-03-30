import type { Meta, StoryObj } from '@storybook/react-vite';

import { Textarea } from '../../shadcn/textarea';
import { Label } from '../../shadcn/label';
import { Button } from '../../shadcn/button';

const meta = {
  title: 'Components/Textarea',
  component: Textarea,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    placeholder: 'Type your message here.',
    className: 'w-80',
  },
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-80 gap-1.5">
      <Label htmlFor="message">Your message</Label>
      <Textarea id="message" placeholder="Type your message here." />
    </div>
  ),
};

export const WithText: Story = {
  render: () => (
    <div className="grid w-80 gap-1.5">
      <Label htmlFor="bio">Bio</Label>
      <Textarea id="bio" placeholder="Tell us about yourself" />
      <p className="text-muted-foreground text-sm">Your bio will be visible to other users.</p>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    placeholder: 'Disabled textarea',
    disabled: true,
    className: 'w-80',
  },
};

export const FormExample: Story = {
  render: () => (
    <div className="grid w-80 gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="feedback">Feedback</Label>
        <Textarea id="feedback" placeholder="Share your feedback..." rows={5} />
      </div>
      <Button>Submit</Button>
    </div>
  ),
};
