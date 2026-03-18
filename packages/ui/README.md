# @arcaai/ui

A comprehensive shared UI component library for ARCAAI applications, built with modern technologies and best practices.

## Features

- **React 19** - Latest React with improved performance
- **Tailwind CSS v4** - CSS-first configuration with design tokens
- **DaisyUI v5** - Additional theming and utility components
- **Radix UI Primitives** - Accessible, unstyled components
- **shadcn/ui Patterns** - Modern component architecture with `cva` variants
- **TypeScript** - Full type safety with exported types
- **Dark Mode** - Built-in dark mode support via CSS variables

## Installation

Add the package to your application in the monorepo:

```json
{
  "dependencies": {
    "@arcaai/ui": "workspace:*"
  }
}
```

Then run:

```bash
pnpm install
```

## Setup

### 1. Import Styles

Import the styles in your global CSS file:

```css
/* In your app/globals.css or similar */
@import "@arcaai/ui/styles.css";
```

### 2. Configure Tailwind (if needed)

If your app uses Tailwind CSS, ensure it scans the UI package:

```ts
// tailwind.config.ts
export default {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}", // Add this line
  ],
};
```

### 3. Tooltip Provider (Optional)

If using Tooltip components, wrap your app with the provider:

```tsx
import { TooltipProvider } from "@arcaai/ui";

function App({ children }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
```

## Usage Examples

### Button

```tsx
import { Button } from "@arcaai/ui";

// Variants
<Button variant="default">Primary</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="destructive">Destructive</Button>
<Button variant="link">Link</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large</Button>
<Button size="icon"><IconComponent /></Button>

// As child (polymorphic)
<Button asChild>
  <a href="/link">Link Button</a>
</Button>
```

### Card

```tsx
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@arcaai/ui";

<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description goes here</CardDescription>
  </CardHeader>
  <CardContent>
    <p>Main content of the card</p>
  </CardContent>
  <CardFooter>
    <Button>Action</Button>
  </CardFooter>
</Card>;
```

### Form with Validation

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  Input,
  Button,
} from "@arcaai/ui";

const schema = z.object({
  email: z.string().email(),
});

function MyForm() {
  const form = useForm({
    resolver: zodResolver(schema),
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="email@example.com" {...field} />
              </FormControl>
              <FormDescription>Your email address</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Submit</Button>
      </form>
    </Form>
  );
}
```

### Dialog

```tsx
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from "@arcaai/ui";

<Dialog>
  <DialogTrigger asChild>
    <Button>Open Dialog</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Dialog Title</DialogTitle>
      <DialogDescription>Dialog description here</DialogDescription>
    </DialogHeader>
    <div>Dialog content</div>
    <DialogFooter>
      <Button variant="outline">Cancel</Button>
      <Button>Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>;
```

### Select

```tsx
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@arcaai/ui";

<Select>
  <SelectTrigger className="w-[180px]">
    <SelectValue placeholder="Select option" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="option1">Option 1</SelectItem>
    <SelectItem value="option2">Option 2</SelectItem>
    <SelectItem value="option3">Option 3</SelectItem>
  </SelectContent>
</Select>;
```

### Alert

```tsx
import { Alert, AlertTitle, AlertDescription } from "@arcaai/ui";
import { InfoIcon } from "lucide-react";

<Alert>
  <InfoIcon />
  <AlertTitle>Information</AlertTitle>
  <AlertDescription>This is an informational message.</AlertDescription>
</Alert>

<Alert variant="destructive">
  <AlertTitle>Error</AlertTitle>
  <AlertDescription>Something went wrong.</AlertDescription>
</Alert>
```

## Available Components

### Base Components

| Component    | Description                         |
| ------------ | ----------------------------------- |
| `Button`     | Clickable button with variants      |
| `Input`      | Text input field                    |
| `Label`      | Form label with accessibility       |
| `Textarea`   | Multi-line text input               |

### Feedback Components

| Component    | Description                         |
| ------------ | ----------------------------------- |
| `Alert`      | Alert messages with variants        |
| `Badge`      | Status indicators and labels        |
| `Skeleton`   | Loading placeholder                 |

### Layout Components

| Component    | Description                         |
| ------------ | ----------------------------------- |
| `Card`       | Content container with sections     |
| `Separator`  | Visual divider                      |
| `Table`      | Data table with styling             |

### Overlay Components

| Component    | Description                         |
| ------------ | ----------------------------------- |
| `Dialog`     | Modal dialog windows                |
| `Popover`    | Floating content panels             |
| `Tooltip`    | Hover information tooltips          |

### Form Components

| Component    | Description                         |
| ------------ | ----------------------------------- |
| `Checkbox`   | Boolean selection                   |
| `Select`     | Dropdown selection                  |
| `Form`       | Form with react-hook-form           |

## Utilities

### `cn()` - Class Name Utility

Combines class names with Tailwind merge for de-duplication:

```tsx
import { cn } from "@arcaai/ui";

<div className={cn("base-class", condition && "conditional-class", className)} />;
```

### `sleep()` - Async Delay

```tsx
import { sleep } from "@arcaai/ui";

await sleep(1000); // Wait 1 second
```

## Development

```bash
# Build the package
pnpm --filter @arcaai/ui build

# Watch mode for development
pnpm --filter @arcaai/ui dev

# Type checking
pnpm --filter @arcaai/ui check-types

# Linting
pnpm --filter @arcaai/ui lint
```

## Adding New Components

1. Create a new file in `src/components/`
2. Follow the existing patterns (use `cn()`, add `data-slot` attributes)
3. Define variants using `cva` if applicable
4. Export from `src/index.ts`
5. Update this README

## Tech Stack

- React 19
- Tailwind CSS v4.1+
- DaisyUI v5.5+
- Radix UI Primitives
- class-variance-authority (cva)
- Lucide React Icons
- TypeScript 5.8+

## License

Internal use only - ARCAAI