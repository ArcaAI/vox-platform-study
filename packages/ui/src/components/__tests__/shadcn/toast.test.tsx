import { test, expect } from '@playwright/experimental-ct-react'
import { toast } from '../../shadcn/toast'

test.describe('Toast', () => {
  test.describe('export', () => {
    test('toast function is exported', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast).toBeDefined()
      expect(typeof toast).toBe('function')
    })

    test('toast has success method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.success).toBeDefined()
      expect(typeof toast.success).toBe('function')
    })

    test('toast has error method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.error).toBeDefined()
      expect(typeof toast.error).toBe('function')
    })

    test('toast has warning method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.warning).toBeDefined()
      expect(typeof toast.warning).toBe('function')
    })

    test('toast has info method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.info).toBeDefined()
      expect(typeof toast.info).toBe('function')
    })

    test('toast has loading method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.loading).toBeDefined()
      expect(typeof toast.loading).toBe('function')
    })

    test('toast has promise method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.promise).toBeDefined()
      expect(typeof toast.promise).toBe('function')
    })

    test('toast has dismiss method', async ({ mount }) => {
      await mount(<div>placeholder</div>)
      expect(toast.dismiss).toBeDefined()
      expect(typeof toast.dismiss).toBe('function')
    })
  })
})
