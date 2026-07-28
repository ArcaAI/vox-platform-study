import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { IssueReportForm } from '../../../registries/manifest/issue-report-form';

describe('IssueReportForm', () => {
  it('renders without crashing', () => {
    const { container } = render(<IssueReportForm />);
    expect(container.firstChild).toBeTruthy();
  });
});
