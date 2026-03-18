import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PaymentConfirmed } from '../../../registries/manifest/payment-confirmed'

describe('PaymentConfirmed', () => {
  it('renders without crashing', () => {
    const { container } = render(<PaymentConfirmed />)
    expect(container.firstChild).toBeTruthy()
  })
})
