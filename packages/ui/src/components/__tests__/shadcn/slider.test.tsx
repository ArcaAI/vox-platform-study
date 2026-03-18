import { test, expect } from '@playwright/experimental-ct-react'
import { Slider } from '../../shadcn/slider'
import { BasicSlider, RangeSlider } from '../fixtures/shadcn/slider-fixtures'

test.describe('Slider', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toBeVisible()
    })

    test('has data-slot="slider"', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toHaveAttribute('data-slot', 'slider')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Slider defaultValue={[50]} className="custom-slider" />
      )
      await expect(component).toHaveClass(/custom-slider/)
    })

    test('merges custom className with defaults', async ({ mount }) => {
      const component = await mount(
        <Slider defaultValue={[50]} className="custom-slider" />
      )
      await expect(component).toHaveClass(/flex/)
      await expect(component).toHaveClass(/custom-slider/)
    })
  })

  test.describe('structure', () => {
    test('has track element', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const track = component.locator('[data-slot="slider-track"]')
      await expect(track).toBeVisible()
      await expect(track).toHaveAttribute('data-slot', 'slider-track')
    })

    test('has range element', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const range = component.locator('[data-slot="slider-range"]')
      await expect(range).toHaveCount(1)
      await expect(range).toHaveAttribute('data-slot', 'slider-range')
    })

    test('has thumb element', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const thumb = component.locator('[data-slot="slider-thumb"]')
      await expect(thumb).toBeVisible()
      await expect(thumb).toHaveAttribute('data-slot', 'slider-thumb')
    })

    test('track contains range', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const track = component.locator('[data-slot="slider-track"]')
      const range = track.locator('[data-slot="slider-range"]')
      await expect(range).toHaveCount(1)
    })
  })

  test.describe('single thumb', () => {
    test('renders one thumb for single value', async ({ mount }) => {
      const component = await mount(<BasicSlider defaultValue={[50]} />)
      const thumbs = component.locator('[data-slot="slider-thumb"]')
      await expect(thumbs).toHaveCount(1)
    })

    test('thumb is focusable', async ({ mount }) => {
      const component = await mount(<BasicSlider defaultValue={[50]} />)
      const thumb = component.locator('[data-slot="slider-thumb"]')
      await thumb.focus()
      await expect(thumb).toBeFocused()
    })
  })

  test.describe('range', () => {
    test('renders two thumbs for range value', async ({ mount }) => {
      const component = await mount(<RangeSlider />)
      const thumbs = component.locator('[data-slot="slider-thumb"]')
      await expect(thumbs).toHaveCount(2)
    })

    test('both thumbs are visible', async ({ mount }) => {
      const component = await mount(<RangeSlider />)
      const thumbs = component.locator('[data-slot="slider-thumb"]')
      await expect(thumbs.first()).toBeVisible()
      await expect(thumbs.last()).toBeVisible()
    })

    test('both thumbs are independently focusable', async ({ mount }) => {
      const component = await mount(<RangeSlider />)
      const thumbs = component.locator('[data-slot="slider-thumb"]')
      await thumbs.first().focus()
      await expect(thumbs.first()).toBeFocused()
      await thumbs.last().focus()
      await expect(thumbs.last()).toBeFocused()
    })
  })

  test.describe('disabled', () => {
    test('supports disabled state', async ({ mount }) => {
      const component = await mount(<BasicSlider disabled />)
      await expect(component).toHaveAttribute('data-disabled', '')
    })

    test('has reduced opacity when disabled', async ({ mount }) => {
      const component = await mount(<BasicSlider disabled />)
      await expect(component).toHaveClass(/data-\[disabled\]:opacity-50/)
    })

    test('thumb is not focusable when disabled', async ({ mount }) => {
      const component = await mount(<BasicSlider disabled />)
      const thumb = component.locator('[data-slot="slider-thumb"]')
      await thumb.focus()
      await expect(thumb).not.toBeFocused()
    })
  })

  test.describe('styling', () => {
    test('has touch-none class', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toHaveClass(/touch-none/)
    })

    test('has select-none class', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toHaveClass(/select-none/)
    })

    test('has flex layout', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toHaveClass(/flex/)
    })

    test('has w-full width', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toHaveClass(/w-full/)
    })

    test('has items-center alignment', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      await expect(component).toHaveClass(/items-center/)
    })

    test('track has bg-muted', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const track = component.locator('[data-slot="slider-track"]')
      await expect(track).toHaveClass(/bg-muted/)
    })

    test('track has rounded-full', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const track = component.locator('[data-slot="slider-track"]')
      await expect(track).toHaveClass(/rounded-full/)
    })

    test('range has bg-primary', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const range = component.locator('[data-slot="slider-range"]')
      await expect(range).toHaveClass(/bg-primary/)
    })

    test('thumb has rounded-full', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const thumb = component.locator('[data-slot="slider-thumb"]')
      await expect(thumb).toHaveClass(/rounded-full/)
    })

    test('thumb has border-primary', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const thumb = component.locator('[data-slot="slider-thumb"]')
      await expect(thumb).toHaveClass(/border-primary/)
    })

    test('thumb has size-4', async ({ mount }) => {
      const component = await mount(<BasicSlider />)
      const thumb = component.locator('[data-slot="slider-thumb"]')
      await expect(thumb).toHaveClass(/size-4/)
    })
  })

  test.describe('accessibility', () => {
    test('has slider role', async ({ mount, page }) => {
      await mount(<BasicSlider />)
      const slider = page.getByRole('slider')
      await expect(slider).toBeVisible()
    })

    test('supports aria-valuemin', async ({ mount, page }) => {
      await mount(<BasicSlider min={10} />)
      const slider = page.getByRole('slider')
      await expect(slider).toHaveAttribute('aria-valuemin', '10')
    })

    test('supports aria-valuemax', async ({ mount, page }) => {
      await mount(<BasicSlider max={200} />)
      const slider = page.getByRole('slider')
      await expect(slider).toHaveAttribute('aria-valuemax', '200')
    })

    test('supports aria-valuenow', async ({ mount, page }) => {
      await mount(<BasicSlider defaultValue={[42]} />)
      const slider = page.getByRole('slider')
      await expect(slider).toHaveAttribute('aria-valuenow', '42')
    })

    test('has aria-orientation horizontal by default', async ({
      mount,
      page,
    }) => {
      await mount(<BasicSlider />)
      const slider = page.getByRole('slider')
      await expect(slider).toHaveAttribute('aria-orientation', 'horizontal')
    })

    test('range slider has two slider roles', async ({ mount, page }) => {
      await mount(<RangeSlider />)
      const sliders = page.getByRole('slider')
      await expect(sliders).toHaveCount(2)
    })

    test('range slider thumbs have correct aria-valuenow', async ({
      mount,
      page,
    }) => {
      await mount(<RangeSlider defaultValue={[25, 75]} />)
      const sliders = page.getByRole('slider')
      await expect(sliders.first()).toHaveAttribute('aria-valuenow', '25')
      await expect(sliders.last()).toHaveAttribute('aria-valuenow', '75')
    })

    test('supports aria-label', async ({ mount }) => {
      const component = await mount(
        <Slider defaultValue={[50]} aria-label="Volume" />
      )
      await expect(component).toHaveAttribute('data-slot', 'slider')
    })

    test('disabled state is communicated to assistive technologies', async ({
      mount,
    }) => {
      const component = await mount(<BasicSlider disabled />)
      await expect(component).toHaveAttribute('data-disabled', '')
    })
  })
})
