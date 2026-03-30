import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Stepper,
  StepperList,
  StepperItem,
  StepperTrigger,
  StepperIndicator,
  StepperSeparator,
  StepperTitle,
} from '@/components/registries/diceui/stepper';

const meta = {
  title: 'Registries/DiceUI/Stepper',
  component: Stepper,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Stepper defaultValue="1">
      <StepperList>
        <StepperItem value="1">
          <StepperTrigger>
            <StepperIndicator />
            <StepperTitle>Step 1</StepperTitle>
          </StepperTrigger>
          <StepperSeparator />
        </StepperItem>
        <StepperItem value="2">
          <StepperTrigger>
            <StepperIndicator />
            <StepperTitle>Step 2</StepperTitle>
          </StepperTrigger>
          <StepperSeparator />
        </StepperItem>
        <StepperItem value="3">
          <StepperTrigger>
            <StepperIndicator />
            <StepperTitle>Step 3</StepperTitle>
          </StepperTrigger>
        </StepperItem>
      </StepperList>
    </Stepper>
  ),
};
