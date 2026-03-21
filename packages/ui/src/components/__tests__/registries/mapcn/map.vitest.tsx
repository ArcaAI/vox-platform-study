import { describe, it, expect } from 'vitest'

describe('Mapcn', () => {
  it('exports Map component', async () => {
    const mod = await import('../../../registries/mapcn/map')
    expect(mod.Map).toBeDefined()
  })
})
