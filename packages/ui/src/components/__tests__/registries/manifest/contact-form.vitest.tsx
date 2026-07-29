import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ContactForm } from '../../../registries/manifest/contact-form';

describe('ContactForm', () => {
  it('renders without crashing', () => {
    const { container } = render(<ContactForm />);
    expect(container.firstChild).toBeTruthy();
  });
});
