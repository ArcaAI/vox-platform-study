import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../../../registries/basecn/card';
import { Button } from '../../../registries/basecn/button';

const meta = {
  title: 'Registries/Basecn/Card',
  component: Card,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
        <CardDescription>Card description goes here.</CardDescription>
      </CardHeader>
      <CardContent>
        <p>Card content area.</p>
      </CardContent>
      <CardFooter>
        <Button>Action</Button>
      </CardFooter>
    </Card>
  ),
};
