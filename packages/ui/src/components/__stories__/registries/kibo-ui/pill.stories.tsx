import type { Meta, StoryObj } from '@storybook/react-vite';

import { Pill, PillStatus, PillIndicator, PillDelta } from '../../../registries/kibo-ui/pill';

const meta = {
  title: 'Registries/KiboUI/Pill',
  component: Pill,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Pill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Pill>Default Pill</Pill>,
};

export const WithStatus: Story = {
  render: () => (
    <Pill>
      <PillStatus>
        <PillIndicator variant="success" pulse />
        Active
      </PillStatus>
      Running
    </Pill>
  ),
};

export const WithDelta: Story = {
  render: () => (
    <Pill>
      <PillDelta delta={12.5} />
      12.5%
    </Pill>
  ),
};
