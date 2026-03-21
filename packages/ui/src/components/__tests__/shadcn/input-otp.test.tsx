import { test, expect } from '@playwright/experimental-ct-react'
import {
  BasicOTP,
  SingleGroupOTP,
  OTPWithCustomClass,
} from '../fixtures/shadcn/input-otp-fixtures'

test.describe('InputOTP', () => {
  test.describe('rendering', () => {
    test('renders InputOTP with data-slot', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await expect(otp).toBeVisible()
    })

    test('renders InputOTPGroup with data-slot', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const groups = page.locator('[data-slot="input-otp-group"]')
      await expect(groups.first()).toBeVisible()
    })

    test('renders correct number of groups', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const groups = page.locator('[data-slot="input-otp-group"]')
      await expect(groups).toHaveCount(2)
    })

    test('renders correct number of slots', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const slots = page.locator('[data-slot="input-otp-slot"]')
      await expect(slots).toHaveCount(6)
    })

    test('renders single group with 4 slots', async ({ mount, page }) => {
      await mount(<SingleGroupOTP />)
      const groups = page.locator('[data-slot="input-otp-group"]')
      await expect(groups).toHaveCount(1)
      const slots = page.locator('[data-slot="input-otp-slot"]')
      await expect(slots).toHaveCount(4)
    })
  })

  test.describe('separator', () => {
    test('renders separator with data-slot', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const separator = page.locator('[data-slot="input-otp-separator"]')
      await expect(separator).toBeVisible()
    })

    test('separator has role="separator"', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const separator = page.locator('[data-slot="input-otp-separator"]')
      await expect(separator).toHaveRole('separator')
    })

    test('separator renders between groups', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const separator = page.locator('[data-slot="input-otp-separator"]')
      await expect(separator).toHaveCount(1)
    })

    test('single group OTP has no separator', async ({ mount, page }) => {
      await mount(<SingleGroupOTP />)
      const separator = page.locator('[data-slot="input-otp-separator"]')
      await expect(separator).toHaveCount(0)
    })
  })

  test.describe('active state', () => {
    test('first slot becomes active when OTP is focused', async ({
      mount,
      page,
    }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()

      const firstSlot = page.locator('[data-slot="input-otp-slot"]').first()
      await expect(firstSlot).toHaveAttribute('data-active', 'true')
    })

    test('inactive slots do not have data-active=true', async ({
      mount,
      page,
    }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()

      const secondSlot = page.locator('[data-slot="input-otp-slot"]').nth(1)
      await expect(secondSlot).not.toHaveAttribute('data-active', 'true')
    })
  })

  test.describe('typing', () => {
    test('typing fills the first slot', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()
      await page.keyboard.type('1')

      const firstSlot = page.locator('[data-slot="input-otp-slot"]').first()
      await expect(firstSlot).toContainText('1')
    })

    test('typing multiple characters fills consecutive slots', async ({
      mount,
      page,
    }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()
      await page.keyboard.type('123')

      const slots = page.locator('[data-slot="input-otp-slot"]')
      await expect(slots.nth(0)).toContainText('1')
      await expect(slots.nth(1)).toContainText('2')
      await expect(slots.nth(2)).toContainText('3')
    })

    test('active slot advances after typing', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()
      await page.keyboard.type('1')

      const secondSlot = page.locator('[data-slot="input-otp-slot"]').nth(1)
      await expect(secondSlot).toHaveAttribute('data-active', 'true')
    })

    test('does not exceed maxLength', async ({ mount, page }) => {
      await mount(<SingleGroupOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()
      await page.keyboard.type('12345')

      const slots = page.locator('[data-slot="input-otp-slot"]')
      await expect(slots.nth(0)).toContainText('1')
      await expect(slots.nth(1)).toContainText('2')
      await expect(slots.nth(2)).toContainText('3')
      await expect(slots.nth(3)).toContainText('4')
    })
  })

  test.describe('slot styling', () => {
    test('slots have border styling', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const slot = page.locator('[data-slot="input-otp-slot"]').first()
      await expect(slot).toHaveClass(/border-y/)
    })

    test('first slot has left border radius', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const firstSlot = page.locator('[data-slot="input-otp-slot"]').first()
      await expect(firstSlot).toHaveClass(/first:rounded-l-md/)
    })

    test('last slot has right border radius', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const lastSlot = page
        .locator(
          '[data-slot="input-otp-group"]:first-child [data-slot="input-otp-slot"]'
        )
        .last()
      await expect(lastSlot).toHaveClass(/last:rounded-r-md/)
    })

    test('active slot has ring styling class', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()

      const firstSlot = page.locator('[data-slot="input-otp-slot"]').first()
      await expect(firstSlot).toHaveClass(
        /data-\[active=true\]:ring-\[3px\]/
      )
    })
  })

  test.describe('custom className', () => {
    test('applies custom className to InputOTP', async ({ mount, page }) => {
      await mount(<OTPWithCustomClass />)
      const otp = page.locator('[data-slot="input-otp"]')
      await expect(otp).toHaveClass(/custom-otp-class/)
    })

    test('applies custom className to InputOTPGroup', async ({
      mount,
      page,
    }) => {
      await mount(<OTPWithCustomClass />)
      const group = page.locator('[data-slot="input-otp-group"]')
      await expect(group).toHaveClass(/custom-group-class/)
    })

    test('applies custom className to InputOTPSlot', async ({
      mount,
      page,
    }) => {
      await mount(<OTPWithCustomClass />)
      const slot = page.locator('[data-slot="input-otp-slot"]').first()
      await expect(slot).toHaveClass(/custom-slot-class/)
    })
  })

  test.describe('accessibility', () => {
    test('OTP input is focusable via click', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()

      const activeSlot = page.locator(
        '[data-slot="input-otp-slot"][data-active="true"]'
      )
      await expect(activeSlot).toBeVisible()
    })

    test('OTP input is focusable via keyboard', async ({ mount, page }) => {
      await mount(<BasicOTP />)
      await page.keyboard.press('Tab')

      const activeSlot = page.locator(
        '[data-slot="input-otp-slot"][data-active="true"]'
      )
      await expect(activeSlot).toBeVisible()
    })

    test('backspace removes last entered character', async ({
      mount,
      page,
    }) => {
      await mount(<BasicOTP />)
      const otp = page.locator('[data-slot="input-otp"]')
      await otp.click()
      await page.keyboard.type('12')
      await page.keyboard.press('Backspace')

      const secondSlot = page.locator('[data-slot="input-otp-slot"]').nth(1)
      await expect(secondSlot).not.toContainText('2')
    })
  })
})
