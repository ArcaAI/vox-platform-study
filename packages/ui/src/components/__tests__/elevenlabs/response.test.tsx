import { test, expect } from '@playwright/experimental-ct-react'
import { Response } from '../../elevenlabs/response'

test.describe('Response', () => {
  test.describe('rendering', () => {
    test('renders text content', async ({ mount }) => {
      const component = await mount(<Response>Hello World</Response>)
      await expect(component).toBeVisible()
      await expect(component).toContainText('Hello World')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Response className="custom-response">Test</Response>
      )
      await expect(component).toHaveClass(/custom-response/)
    })

    test('has default size class', async ({ mount }) => {
      const component = await mount(<Response>Test</Response>)
      await expect(component).toHaveClass(/size-full/)
    })
  })

  test.describe('content', () => {
    test('renders short content', async ({ mount }) => {
      const component = await mount(<Response>OK</Response>)
      await expect(component).toContainText('OK')
    })

    test('renders long content', async ({ mount }) => {
      const longText = 'Lorem ipsum dolor sit amet, '.repeat(10)
      const component = await mount(<Response>{longText}</Response>)
      await expect(component).toContainText('Lorem ipsum')
    })

    test('renders empty content', async ({ mount }) => {
      const component = await mount(<Response>{''}</Response>)
      await expect(component).toBeAttached()
    })
  })

  test.describe('memoization', () => {
    test('has display name', async ({ mount }) => {
      const component = await mount(<Response>Test</Response>)
      await expect(component).toBeVisible()
    })
  })
})
