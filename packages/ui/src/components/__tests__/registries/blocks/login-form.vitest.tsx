import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LoginForm } from '../../../registries/blocks/login-form';

describe('LoginForm', () => {
  it('renders without crashing', () => {
    const { container } = render(<LoginForm />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders email and password inputs', () => {
    const { container } = render(<LoginForm />);
    const emailInput = container.querySelector('input[type="email"]');
    const passwordInput = container.querySelector('input[type="password"]');
    expect(emailInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
  });
});
