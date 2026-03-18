import { test, expect } from '@playwright/experimental-ct-react'
import { Toaster } from '../../shadcn/sonner'

test.describe('Sonner Toaster', () => {
  test.describe('export', () => {
    test('Toaster component is exported', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(Toaster).toBeDefined()
      expect(typeof Toaster).toBe('function')
    })
  })
})
