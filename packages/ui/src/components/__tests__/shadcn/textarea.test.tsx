import { test, expect } from '@playwright/experimental-ct-react'
import { Textarea } from '../../shadcn/textarea'
import {
  TextareaChangeTracker,
  TextareaFocusBlurTracker,
  TextareaKeyTracker,
} from '../fixtures/shadcn/textarea-fixtures'

test.describe('Textarea', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount, page }) => {
      await mount(<Textarea />)
      const textarea = page.getByRole('textbox')
      await expect(textarea).toBeVisible()
      await expect(textarea).toHaveAttribute('data-slot', 'textarea')
    })

    test('renders as textarea element', async ({ mount, page }) => {
      await mount(<Textarea />)
      await expect(page.getByRole('textbox')).toHaveRole('textbox')
    })

    test('applies custom className', async ({ mount, page }) => {
      await mount(<Textarea className="custom-textarea" />)
      await expect(page.getByRole('textbox')).toHaveClass(/custom-textarea/)
    })

    test('has minimum height styling', async ({ mount, page }) => {
      await mount(<Textarea />)
      await expect(page.getByRole('textbox')).toHaveClass(/min-h-16/)
    })
  })

  test.describe('states', () => {
    test('handles disabled state', async ({ mount, page }) => {
      await mount(<Textarea disabled />)
      const textarea = page.getByRole('textbox')
      await expect(textarea).toBeDisabled()
      await expect(textarea).toHaveClass(/disabled:opacity-50/)
    })

    test('handles readonly state', async ({ mount, page }) => {
      await mount(<Textarea readOnly />)
      await expect(page.getByRole('textbox')).toHaveAttribute('readonly', '')
    })

    test('handles required state', async ({ mount, page }) => {
      await mount(<Textarea required />)
      await expect(page.getByRole('textbox')).toHaveAttribute('required', '')
    })

    test('is focusable when enabled', async ({ mount, page }) => {
      await mount(<Textarea />)
      const textarea = page.getByRole('textbox')
      await textarea.focus()
      await expect(textarea).toBeFocused()
    })

    test('is not interactable when disabled', async ({ mount, page }) => {
      await mount(<Textarea disabled />)
      const textarea = page.getByRole('textbox')
      await textarea.focus()
      await expect(textarea).not.toBeFocused()
    })
  })

  test.describe('value handling', () => {
    test('displays initial value', async ({ mount, page }) => {
      await mount(<Textarea defaultValue="initial value" />)
      await expect(page.getByRole('textbox')).toHaveValue('initial value')
    })

    test('allows typing in the textarea', async ({ mount, page }) => {
      await mount(<Textarea />)
      const textarea = page.getByRole('textbox')
      await textarea.fill('typed text')
      await expect(textarea).toHaveValue('typed text')
    })

    test('allows multiline text', async ({ mount, page }) => {
      await mount(<Textarea />)
      const textarea = page.getByRole('textbox')
      const multilineText = 'Line 1\nLine 2\nLine 3'
      await textarea.fill(multilineText)
      await expect(textarea).toHaveValue(multilineText)
    })

    test('clears value when filled with empty string', async ({ mount, page }) => {
      await mount(<Textarea defaultValue="initial" />)
      const textarea = page.getByRole('textbox')
      await textarea.fill('')
      await expect(textarea).toHaveValue('')
    })

    test('handles controlled value', async ({ mount, page }) => {
      await mount(<Textarea value="controlled" readOnly />)
      await expect(page.getByRole('textbox')).toHaveValue('controlled')
    })
  })

  test.describe('placeholder', () => {
    test('displays placeholder text', async ({ mount, page }) => {
      await mount(<Textarea placeholder="Enter your message" />)
      await expect(page.getByRole('textbox')).toHaveAttribute(
        'placeholder',
        'Enter your message'
      )
    })

    test('hides placeholder when value is entered', async ({ mount, page }) => {
      await mount(<Textarea placeholder="Enter text" />)
      const textarea = page.getByRole('textbox')
      await textarea.fill('some text')
      await expect(textarea).toHaveValue('some text')
    })
  })

  test.describe('interactions', () => {
    test('handles change events', async ({ mount, page }) => {
      await mount(<TextareaChangeTracker />)
      const textarea = page.getByRole('textbox')
      await textarea.fill('test')
      await expect(page.locator('[data-testid="change-value"]')).toHaveText('test')
    })

    test('handles focus events', async ({ mount, page }) => {
      await mount(<TextareaFocusBlurTracker />)
      const textarea = page.getByRole('textbox')
      await textarea.focus()
      await expect(page.locator('[data-testid="focus-status"]')).toHaveText('focused')
    })

    test('handles blur events', async ({ mount, page }) => {
      await mount(<TextareaFocusBlurTracker />)
      const textarea = page.getByRole('textbox')
      await textarea.focus()
      await textarea.blur()
      await expect(page.locator('[data-testid="focus-status"]')).toHaveText('blurred')
    })

    test('handles keyboard events', async ({ mount, page }) => {
      await mount(<TextareaKeyTracker />)
      const textarea = page.getByRole('textbox')
      await textarea.focus()
      await textarea.press('a')
      await expect(page.locator('[data-testid="key-value"]')).toHaveText('a')
    })
  })

  test.describe('sizing', () => {
    test('supports rows attribute', async ({ mount, page }) => {
      await mount(<Textarea rows={5} />)
      await expect(page.getByRole('textbox')).toHaveAttribute('rows', '5')
    })

    test('supports cols attribute', async ({ mount, page }) => {
      await mount(<Textarea cols={40} />)
      await expect(page.getByRole('textbox')).toHaveAttribute('cols', '40')
    })
  })

  test.describe('validation', () => {
    test('supports aria-invalid for error state', async ({ mount, page }) => {
      await mount(<Textarea aria-invalid="true" />)
      const textarea = page.getByRole('textbox')
      await expect(textarea).toHaveAttribute('aria-invalid', 'true')
      await expect(textarea).toHaveClass(/aria-invalid:border-destructive/)
    })

    test('supports minLength and maxLength', async ({ mount, page }) => {
      await mount(<Textarea minLength={10} maxLength={500} />)
      const textarea = page.getByRole('textbox')
      await expect(textarea).toHaveAttribute('minlength', '10')
      await expect(textarea).toHaveAttribute('maxlength', '500')
    })
  })

  test.describe('accessibility', () => {
    test('supports aria-label', async ({ mount, page }) => {
      await mount(<Textarea aria-label="Comments" />)
      await expect(page.getByRole('textbox')).toHaveAccessibleName('Comments')
    })

    test('supports aria-describedby', async ({ mount, page }) => {
      await mount(
        <div>
          <Textarea aria-describedby="hint" />
          <span id="hint">Enter your feedback</span>
        </div>
      )
      const textarea = page.getByRole('textbox')
      await expect(textarea).toHaveAttribute('aria-describedby', 'hint')
    })

    test('supports id for label association', async ({ mount, page }) => {
      await mount(
        <div>
          <label htmlFor="comments">Comments</label>
          <Textarea id="comments" />
        </div>
      )
      const textarea = page.getByRole('textbox')
      await expect(textarea).toHaveAttribute('id', 'comments')
      await expect(textarea).toHaveAccessibleName('Comments')
    })

    test('indicates disabled state to assistive technologies', async ({
      mount,
      page,
    }) => {
      await mount(<Textarea disabled />)
      await expect(page.getByRole('textbox')).toBeDisabled()
    })

    test('indicates required state to assistive technologies', async ({
      mount,
      page,
    }) => {
      await mount(<Textarea required aria-label="Required field" />)
      await expect(page.getByRole('textbox')).toHaveAttribute('required', '')
    })
  })

  test.describe('styling', () => {
    test('has full width styling', async ({ mount, page }) => {
      await mount(<Textarea />)
      await expect(page.getByRole('textbox')).toHaveClass(/w-full/)
    })

    test('has rounded corners', async ({ mount, page }) => {
      await mount(<Textarea />)
      await expect(page.getByRole('textbox')).toHaveClass(/rounded-md/)
    })

    test('has border styling', async ({ mount, page }) => {
      await mount(<Textarea />)
      await expect(page.getByRole('textbox')).toHaveClass(/border/)
    })

    test('has focus ring on focus', async ({ mount, page }) => {
      await mount(<Textarea />)
      await expect(page.getByRole('textbox')).toHaveClass(/focus-visible:ring/)
    })
  })

  test.describe('form integration', () => {
    test('supports name attribute', async ({ mount, page }) => {
      await mount(<Textarea name="message" />)
      await expect(page.getByRole('textbox')).toHaveAttribute('name', 'message')
    })

    test('supports form attribute', async ({ mount, page }) => {
      await mount(<Textarea form="contact-form" />)
      await expect(page.getByRole('textbox')).toHaveAttribute('form', 'contact-form')
    })
  })
})
