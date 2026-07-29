import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Steps, StepsItem, StepsTrigger, StepsContent } from '../../../registries/prompt-kit/steps';

describe('Steps', () => {
  it('renders without crashing', () => {
    render(
      <Steps>
        <StepsItem>
          <StepsTrigger>Step 1</StepsTrigger>
          <StepsContent>Content 1</StepsContent>
        </StepsItem>
      </Steps>,
    );
    expect(screen.getByText('Step 1')).toBeInTheDocument();
  });
});
