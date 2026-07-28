import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PhoneInput, PhoneInputCountrySelect, PhoneInputField } from '@/components/registries/diceui/phone-input';

describe('PhoneInput', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <PhoneInput>
        <PhoneInputCountrySelect />
        <PhoneInputField />
      </PhoneInput>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
