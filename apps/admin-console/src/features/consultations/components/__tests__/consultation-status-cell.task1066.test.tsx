import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsultationStatusBadge } from '../consultation-status-badge';

afterEach(cleanup);

describe('ConsultationStatusBadge compact (grid cell)', () => {
  it('renders one badge plus a single muted secondary line, never stacked badges', () => {
    const { container } = render(
      <ConsultationStatusBadge compact status="STOPPED" processing="AWAITING_REVIEW" processingReason="GUARDRAIL_HOLD" />,
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
    const secondary = screen.getByText(/Awaiting review/);
    expect(secondary.textContent).toContain('Guardrail hold');
    expect(secondary.className).toContain('truncate');
    expect(secondary.getAttribute('title')).toContain('Guardrail hold');
    expect(container.querySelectorAll('[data-slot="status-badge"]').length).toBeLessThanOrEqual(1);
  });

  it('has no secondary line when there is nothing extra', () => {
    render(<ConsultationStatusBadge compact status="OPEN" processing="IDLE" />);
    expect(screen.queryByTestId('status-secondary')).toBeNull();
  });
});
