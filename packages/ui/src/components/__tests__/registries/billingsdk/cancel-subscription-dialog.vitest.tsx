import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CancelSubscriptionDialog } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

describe('CancelSubscriptionDialog', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CancelSubscriptionDialog title="Cancel" description="Sure?" plan={plans[1]} onCancel={() => {}} onKeepSubscription={() => {}} />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
