import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Steps,
  StepsContent,
  StepsItem,
  StepsTrigger,
} from '../../../registries/prompt-kit/steps'

const meta = {
  title: 'Registries/PromptKit/Steps',
  component: Steps,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Steps>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Steps>
      <StepsItem>
        <StepsTrigger>Step 1: Initialize</StepsTrigger>
        <StepsContent>
          <p>Content for the first step.</p>
        </StepsContent>
      </StepsItem>
      <StepsItem>
        <StepsTrigger>Step 2: Process</StepsTrigger>
        <StepsContent>
          <p>Content for the second step.</p>
        </StepsContent>
      </StepsItem>
    </Steps>
  ),
}
