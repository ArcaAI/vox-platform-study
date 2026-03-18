import { describe, it, expect } from 'vitest'

describe('QRCode', () => {
  it('exports QRCode component', async () => {
    const mod = await import('../../../registries/kibo-ui/qr-code/index')
    expect(mod.QRCode).toBeDefined()
  })
})
