# TASK-034: Frontend Demo Gap Remediation

- **Ticket**: TASK-034
- **Created**: 2026-02-20
- **Last Updated**: 2026-02-21
- **Status**: Completed
- **Depends On**: TASK-032 (SDK V2 Frontend Demo Implementation)
- **Blocked By**: TASK-033 (Voice Embedding) for F1-06 only

---

## Requirement Analysis

Close all gaps identified in the code review of `vite-app` and `nextjs-app` examples against the feature specifications UXUI-01, FEAT-01 through FEAT-05. Both apps must use `@arcaai/vox` (agentic-sdk-v2) exclusively for backend integration.

### Acceptance Criteria

1. Both apps pass all FEAT-01 through FEAT-05 requirements
2. Shared components are extracted to avoid duplication
3. Theme switching (light/dark) works and persists
4. All admin features include confirmation dialogs and pagination
5. DNA Writing Style page uses a vertical stepper
6. Both apps are visually consistent and developer-friendly

---

## Architecture Overview

Work is organized into **8 parallel workstreams** that can be executed by separate engineers simultaneously. Each workstream targets a specific gap area and touches isolated files. Workstreams are grouped so that **Workstream A** (shared infrastructure) must complete first, then **Workstreams B-H** can run in parallel.

### Dependency Graph

```
Workstream A (Shared Infrastructure) ──┐
                                       ├── Workstream B (FEAT-01 Setup)
                                       ├── Workstream C (FEAT-02 Transcription)
                                       ├── Workstream D (FEAT-03 Summarization)
                                       ├── Workstream E (FEAT-04 Admin)
                                       ├── Workstream F (FEAT-05 DNA Style)
                                       ├── Workstream G (Cross-Cutting UX)
                                       └── Workstream H (Next.js Parity)
```

### Tech Stack

- React 19, TypeScript 5.8
- Vite 6 / Next.js 15 (App Router)
- Tailwind CSS 4, shadcn/ui (Radix primitives)
- `@arcaai/vox` SDK v2 (workspace dependency)
- Vitest 4 for unit tests
- Playwright for E2E tests

### File Path Conventions

- **Vite app**: `packages/agentic-sdk-v2/examples/vite-app/src/` (aliased as `VITE/`)
- **Next.js app**: `packages/agentic-sdk-v2/examples/nextjs-app/src/` (aliased as `NEXT/`)

---

# Workstream A: Shared Infrastructure (Must Complete First)

**Assignee**: Engineer 1
**Estimated Time**: ~2 hours
**Branch**: `feat/task-034-shared-infrastructure`

This workstream creates shared UI components and utilities used by all other workstreams.

---

## Task A1: Create ThemeProvider and useTheme hook

**Files**:
- Create: `VITE/components/theme-provider.tsx`
- Create: `VITE/lib/use-theme.ts`
- Test: `VITE/components/__tests__/theme-provider.test.tsx`

**Steps**:

1. Write failing test

```typescript
// VITE/components/__tests__/theme-provider.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeProvider, useTheme } from '../theme-provider';

function TestConsumer() {
  const { theme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={toggleTheme}>Toggle</button>
      <button onClick={() => setTheme('dark')}>Dark</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark', 'light');
  });

  it('defaults to light theme', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('toggles between light and dark', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists theme to localStorage', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('Dark'));
    expect(localStorage.getItem('arcaai-theme')).toBe('dark');
  });

  it('restores theme from localStorage', () => {
    localStorage.setItem('arcaai-theme', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });
});
```

2. Verify test fails

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/theme-provider.test.tsx
# Expected: 4 failing (module not found)
```

3. Implement ThemeProvider

```typescript
// VITE/components/theme-provider.tsx
'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'arcaai-theme';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children, defaultTheme = 'light' }: { children: ReactNode; defaultTheme?: Theme }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return defaultTheme;
    return (localStorage.getItem(STORAGE_KEY) as Theme) || defaultTheme;
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggleTheme = useCallback(() => setThemeState((prev) => (prev === 'light' ? 'dark' : 'light')), []);

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
```

4. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/theme-provider.test.tsx
# Expected: 4 passing
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/theme-provider.tsx packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/theme-provider.test.tsx
git commit -m "feat(vite-app): add ThemeProvider with localStorage persistence"
```

---

## Task A2: Create ThemeToggle UI component

**Files**:
- Create: `VITE/components/ui/theme-toggle.tsx`
- Test: `VITE/components/__tests__/theme-toggle.test.tsx`

**Steps**:

1. Write failing test

```typescript
// VITE/components/__tests__/theme-toggle.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ThemeProvider } from '../theme-provider';
import { ThemeToggle } from '../ui/theme-toggle';

describe('ThemeToggle', () => {
  it('renders sun icon in light mode', () => {
    render(
      <ThemeProvider defaultTheme="light">
        <ThemeToggle />
      </ThemeProvider>
    );
    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
  });

  it('switches to dark mode on click', () => {
    render(
      <ThemeProvider defaultTheme="light">
        <ThemeToggle />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
```

2. Verify test fails

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/theme-toggle.test.tsx
# Expected: 2 failing
```

3. Implement ThemeToggle

```typescript
// VITE/components/ui/theme-toggle.tsx
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
      {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </Button>
  );
}
```

4. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/theme-toggle.test.tsx
# Expected: 2 passing
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/ui/theme-toggle.tsx packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/theme-toggle.test.tsx
git commit -m "feat(vite-app): add ThemeToggle button component"
```

---

## Task A3: Create VerticalStepper component

**Files**:
- Create: `VITE/components/ui/vertical-stepper.tsx`
- Test: `VITE/components/__tests__/vertical-stepper.test.tsx`

**Steps**:

1. Write failing test

```typescript
// VITE/components/__tests__/vertical-stepper.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { VerticalStepper, type StepConfig } from '../ui/vertical-stepper';

const steps: StepConfig[] = [
  { id: 'select', label: 'Select Consultation', description: 'Choose a consultation' },
  { id: 'review', label: 'Review Summary', description: 'Review the raw summary' },
  { id: 'existing', label: 'Existing DNA', description: 'View existing report' },
  { id: 'prompt', label: 'Select Prompt', description: 'Choose generation prompt' },
  { id: 'generate', label: 'Generate', description: 'Run DNA generation' },
];

describe('VerticalStepper', () => {
  it('renders all step labels', () => {
    render(<VerticalStepper steps={steps} currentStep={0}>{null}</VerticalStepper>);
    steps.forEach((s) => {
      expect(screen.getByText(s.label)).toBeInTheDocument();
    });
  });

  it('marks completed steps', () => {
    render(<VerticalStepper steps={steps} currentStep={2}>{null}</VerticalStepper>);
    const stepElements = screen.getAllByTestId(/^step-indicator-/);
    expect(stepElements[0].getAttribute('data-status')).toBe('completed');
    expect(stepElements[1].getAttribute('data-status')).toBe('completed');
    expect(stepElements[2].getAttribute('data-status')).toBe('active');
    expect(stepElements[3].getAttribute('data-status')).toBe('pending');
  });

  it('renders children for the active step', () => {
    render(
      <VerticalStepper steps={steps} currentStep={1}>
        <div data-testid="step-content">Active content</div>
      </VerticalStepper>
    );
    expect(screen.getByTestId('step-content')).toBeInTheDocument();
  });
});
```

2. Verify test fails

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/vertical-stepper.test.tsx
# Expected: 3 failing
```

3. Implement VerticalStepper

```typescript
// VITE/components/ui/vertical-stepper.tsx
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StepConfig {
  id: string;
  label: string;
  description?: string;
}

type StepStatus = 'completed' | 'active' | 'pending';

interface VerticalStepperProps {
  steps: StepConfig[];
  currentStep: number;
  children: React.ReactNode;
  className?: string;
}

function getStatus(index: number, current: number): StepStatus {
  if (index < current) return 'completed';
  if (index === current) return 'active';
  return 'pending';
}

export function VerticalStepper({ steps, currentStep, children, className }: VerticalStepperProps) {
  return (
    <div className={cn('flex gap-8', className)}>
      <div className="flex flex-col items-center">
        {steps.map((step, i) => {
          const status = getStatus(i, currentStep);
          return (
            <div key={step.id} className="flex flex-col items-center">
              <div
                data-testid={`step-indicator-${step.id}`}
                data-status={status}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors',
                  status === 'completed' && 'border-primary bg-primary text-primary-foreground',
                  status === 'active' && 'border-primary bg-background text-primary',
                  status === 'pending' && 'border-muted-foreground/30 bg-background text-muted-foreground/50',
                )}
              >
                {status === 'completed' ? <Check className="h-5 w-5" /> : i + 1}
              </div>
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    'w-0.5 min-h-8 flex-1',
                    i < currentStep ? 'bg-primary' : 'bg-muted-foreground/20',
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1 space-y-6">
        {steps.map((step, i) => {
          const status = getStatus(i, currentStep);
          return (
            <div key={step.id} className={cn('min-h-[4rem]', status === 'pending' && 'opacity-40')}>
              <h3
                className={cn(
                  'text-sm font-semibold',
                  status === 'active' && 'text-primary',
                  status === 'completed' && 'text-foreground',
                  status === 'pending' && 'text-muted-foreground',
                )}
              >
                {step.label}
              </h3>
              {step.description && (
                <p className="text-xs text-muted-foreground">{step.description}</p>
              )}
              {status === 'active' && <div className="mt-3">{children}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

4. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/vertical-stepper.test.tsx
# Expected: 3 passing
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/ui/vertical-stepper.tsx packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/vertical-stepper.test.tsx
git commit -m "feat(vite-app): add VerticalStepper component for multi-step workflows"
```

---

## Task A4: Create ConfirmDialog component

**Files**:
- Create: `VITE/components/ui/confirm-dialog.tsx`
- Test: `VITE/components/__tests__/confirm-dialog.test.tsx`

**Steps**:

1. Write failing test

```typescript
// VITE/components/__tests__/confirm-dialog.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from '../ui/confirm-dialog';

describe('ConfirmDialog', () => {
  it('renders trigger button', () => {
    render(
      <ConfirmDialog
        title="Delete user?"
        description="This action cannot be undone."
        onConfirm={vi.fn()}
        trigger={<button>Delete</button>}
      />
    );
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls onConfirm when confirmed', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete user?"
        description="This action cannot be undone."
        onConfirm={onConfirm}
        trigger={<button>Delete</button>}
      />
    );
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Continue'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
```

2. Verify test fails

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/confirm-dialog.test.tsx
# Expected: 2 failing
```

3. Implement ConfirmDialog

```typescript
// VITE/components/ui/confirm-dialog.tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@radix-ui/react-alert-dialog';

interface ConfirmDialogProps {
  title: string;
  description: string;
  onConfirm: () => void;
  trigger: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
}

export function ConfirmDialog({
  title,
  description,
  onConfirm,
  trigger,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  variant = 'destructive',
}: ConfirmDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent className="rounded-lg border bg-background p-6 shadow-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-semibold">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted-foreground">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-4 flex justify-end gap-2">
          <AlertDialogCancel className="rounded-md border px-4 py-2 text-sm">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={`rounded-md px-4 py-2 text-sm text-white ${
              variant === 'destructive' ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

4. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/confirm-dialog.test.tsx
# Expected: 2 passing
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/ui/confirm-dialog.tsx packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/confirm-dialog.test.tsx
git commit -m "feat(vite-app): add ConfirmDialog for destructive action confirmation"
```

---

## Task A5: Create Pagination component

**Files**:
- Create: `VITE/components/ui/pagination.tsx`
- Test: `VITE/components/__tests__/pagination.test.tsx`

**Steps**:

1. Write failing test

```typescript
// VITE/components/__tests__/pagination.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Pagination } from '../ui/pagination';

describe('Pagination', () => {
  it('renders page info', () => {
    render(<Pagination currentPage={1} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByText('Page 1 of 5')).toBeInTheDocument();
  });

  it('disables previous on first page', () => {
    render(<Pagination currentPage={1} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });

  it('disables next on last page', () => {
    render(<Pagination currentPage={5} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('calls onPageChange with next page', () => {
    const onChange = vi.fn();
    render(<Pagination currentPage={2} totalPages={5} onPageChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onChange).toHaveBeenCalledWith(3);
  });
});
```

2. Verify test fails

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/pagination.test.tsx
# Expected: 4 failing
```

3. Implement Pagination

```typescript
// VITE/components/ui/pagination.tsx
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between border-t pt-4">
      <span className="text-sm text-muted-foreground">
        Page {currentPage} of {totalPages}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="mr-1 h-4 w-4" /> Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label="Next page"
        >
          Next <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

4. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/pagination.test.tsx
# Expected: 4 passing
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/ui/pagination.tsx packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/pagination.test.tsx
git commit -m "feat(vite-app): add Pagination component for list views"
```

---

## Task A6: Create Toast notification system

**Files**:
- Create: `VITE/components/ui/toast.tsx`
- Create: `VITE/lib/use-toast.ts`
- Test: `VITE/components/__tests__/toast.test.tsx`

**Steps**:

1. Write failing test

```typescript
// VITE/components/__tests__/toast.test.tsx
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToastProvider } from '../ui/toast';
import { useToast } from '@/lib/use-toast';

function TestConsumer() {
  const { toast } = useToast();
  return (
    <button onClick={() => toast({ title: 'Success', description: 'Item created', variant: 'success' })}>
      Show Toast
    </button>
  );
}

describe('Toast', () => {
  it('shows toast message when triggered', async () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );
    act(() => {
      screen.getByText('Show Toast').click();
    });
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Item created')).toBeInTheDocument();
  });
});
```

2. Verify test fails

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/toast.test.tsx
# Expected: 1 failing
```

3. Implement Toast system using Radix Toast primitive

```typescript
// VITE/lib/use-toast.ts
import { createContext, useCallback, useContext, useState } from 'react';

export type ToastVariant = 'default' | 'success' | 'destructive';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
}

export interface ToastContextValue {
  toasts: ToastMessage[];
  toast: (msg: Omit<ToastMessage, 'id'>) => void;
  dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
```

```typescript
// VITE/components/ui/toast.tsx
'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { ToastContext, type ToastMessage, type ToastVariant } from '@/lib/use-toast';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

const variantStyles: Record<ToastVariant, string> = {
  default: 'border-border bg-background',
  success: 'border-green-500/50 bg-green-50 dark:bg-green-950/20',
  destructive: 'border-destructive/50 bg-destructive/10',
};

const variantIcons: Record<ToastVariant, React.ElementType> = {
  default: Info,
  success: CheckCircle,
  destructive: AlertCircle,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toast = useCallback((msg: Omit<ToastMessage, 'id'>) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { ...msg, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => {
          const Icon = variantIcons[t.variant || 'default'];
          return (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border p-4 shadow-lg animate-in slide-in-from-right',
                variantStyles[t.variant || 'default'],
              )}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} className="shrink-0">
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
```

4. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/toast.test.tsx
# Expected: 1 passing
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/lib/use-toast.ts packages/agentic-sdk-v2/examples/vite-app/src/components/ui/toast.tsx packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/toast.test.tsx
git commit -m "feat(vite-app): add Toast notification system"
```

---

## Task A7: Integrate ThemeProvider and ToastProvider into App.tsx

**Files**:
- Modify: `VITE/App.tsx`

**Steps**:

1. Modify App.tsx to wrap with providers

```typescript
// Add to existing imports in VITE/App.tsx
import { ThemeProvider } from '@/components/theme-provider';
import { ToastProvider } from '@/components/ui/toast';

// Wrap the existing JSX:
// Before: <AgenticProvider config={config}>...</AgenticProvider>
// After:
// <ThemeProvider>
//   <ToastProvider>
//     <AgenticProvider config={config}>...</AgenticProvider>
//   </ToastProvider>
// </ThemeProvider>
```

2. Verify app still renders

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
# Expected: build succeeds
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/App.tsx
git commit -m "feat(vite-app): integrate ThemeProvider and ToastProvider into app root"
```

---

## Task A8: Add ThemeToggle to Navigation

**Files**:
- Modify: `VITE/components/navigation.tsx`

**Steps**:

1. Add ThemeToggle import and render it next to the ApiSettingsButton

```typescript
// Add import
import { ThemeToggle } from '@/components/ui/theme-toggle';

// In the navigation JSX, add <ThemeToggle /> next to <ApiSettingsButton />
// Look for the section with ApiSettingsButton and NavConnectionBadge
// Add ThemeToggle between them
```

2. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
# Expected: build succeeds
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/navigation.tsx
git commit -m "feat(vite-app): add ThemeToggle to navigation bar"
```

---

# Workstream B: FEAT-01 Setup Page Gaps (Parallel)

**Assignee**: Engineer 2
**Estimated Time**: ~2 hours
**Branch**: `feat/task-034-feat01-setup-gaps`
**Depends On**: Workstream A (ThemeProvider)

---

## Task B1: Add word-level timestamp toggle to Setup page

**Files**:
- Modify: `VITE/pages/setup.tsx`
- Test: `VITE/pages/__tests__/setup.test.tsx` (add test case)

**Steps**:

1. Write failing test

```typescript
// Add to existing setup test file or create new
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@arcaai/vox', () => ({
  useArcaConfig: () => ({ preferences: {}, update: vi.fn(), models: { stt: [], vad: [], ner: [], selected: {} } }),
  useGlobalSettings: () => ({ settings: [], tenantConfig: [], isLoading: false }),
  usePipelines: () => ({ pipelines: [], isLoading: false }),
  useHealthCheck: () => ({ status: 'idle', services: {}, check: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn() }),
  useUserSettings: () => ({ settings: [], mySettings: [], isLoading: false, create: vi.fn(), update: vi.fn(), getMySettings: vi.fn() }),
  HEALTH_ENDPOINTS: { LIVE: '/health/live', READY: '/health/ready' },
  MONITORING_ENDPOINTS: { UPTIME: '/monitoring/uptime', SESSIONS: '/monitoring/sessions' },
}));

describe('Setup Page - Transcription Options', () => {
  it('renders word-level timestamp toggle', () => {
    // render SetupPage with necessary providers
    // expect switch labeled "Word-level Timestamps" to be present
  });

  it('renders noise cancellation selector', () => {
    // expect select labeled "Noise Cancellation" to be present
  });

  it('renders VAD model selector', () => {
    // expect select labeled "Voice Activity Detection" to be present
  });

  it('renders diarization toggle', () => {
    // expect switch labeled "Local Diarization" to be present
  });
});
```

2. Add a new `TranscriptionOptionsCard` component inside setup.tsx

```typescript
function TranscriptionOptionsCard() {
  const { preferences, update, models } = useArcaConfig();
  const [wordTimestamps, setWordTimestamps] = useState(preferences.wordTimestamps ?? false);
  const [noiseCancellation, setNoiseCancellation] = useState(preferences.noiseCancellation ?? true);
  const [vadEnabled, setVadEnabled] = useState(preferences.vadEnabled ?? true);
  const [vadModel, setVadModel] = useState(preferences.vadModel ?? '');
  const [diarizationLocal, setDiarizationLocal] = useState(preferences.diarizationLocal ?? false);

  const handleSave = useCallback(async () => {
    await update({
      wordTimestamps,
      noiseCancellation,
      vadEnabled,
      vadModel,
      diarizationLocal,
    });
  }, [wordTimestamps, noiseCancellation, vadEnabled, vadModel, diarizationLocal, update]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AudioLines className="h-5 w-5" />
          Transcription Options
        </CardTitle>
        <CardDescription>Configure speech-to-text processing options</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Word-level Timestamps toggle */}
        <div className="flex items-center justify-between">
          <Label htmlFor="word-timestamps">Word-level Timestamps</Label>
          <Switch id="word-timestamps" checked={wordTimestamps} onCheckedChange={setWordTimestamps} />
        </div>

        {/* Noise Cancellation toggle + model selector */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="noise-cancel">Noise Cancellation</Label>
            <Switch id="noise-cancel" checked={noiseCancellation} onCheckedChange={setNoiseCancellation} />
          </div>
          {noiseCancellation && models.stt.length > 0 && (
            <Select>
              <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
              <SelectContent>
                {models.stt.filter(m => m.taskType === 'noise-cancellation').map(m => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* VAD toggle + model selector */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="vad-enabled">Voice Activity Detection (VAD)</Label>
            <Switch id="vad-enabled" checked={vadEnabled} onCheckedChange={setVadEnabled} />
          </div>
          {vadEnabled && models.vad.length > 0 && (
            <Select value={vadModel} onValueChange={setVadModel}>
              <SelectTrigger><SelectValue placeholder="Select VAD model" /></SelectTrigger>
              <SelectContent>
                {models.vad.map(m => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Local Diarization toggle */}
        <div className="flex items-center justify-between">
          <Label htmlFor="diarization-local">Local Diarization</Label>
          <Switch id="diarization-local" checked={diarizationLocal} onCheckedChange={setDiarizationLocal} />
        </div>
        {diarizationLocal && (
          <p className="text-xs text-muted-foreground">
            Uses VAD and voice embedding for client-side speaker recognition.
          </p>
        )}

        <Button onClick={handleSave} className="w-full mt-4">
          <Save className="mr-2 h-4 w-4" /> Save Transcription Options
        </Button>
      </CardContent>
    </Card>
  );
}
```

3. Add `<TranscriptionOptionsCard />` to the page grid layout

4. Verify test passes and build succeeds

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/pages/__tests__/setup.test.tsx
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx
git commit -m "feat(vite-app): add transcription options card to setup page (F1-02..F1-05)"
```

---

## Task B2: Persist user settings to backend via useUserSettings

**Files**:
- Modify: `VITE/pages/setup.tsx`

**Steps**:

1. In the `PersonalizationCard` and `TranscriptionOptionsCard`, add backend persistence:

```typescript
// Inside the card components, after saving to useArcaConfig, also persist to backend:
const { create, update: updateSetting, getMySettings } = useUserSettings();
const apiConfig = getApiConfig();

// On mount, fetch settings from backend
useEffect(() => {
  if (apiConfig.doctorId) {
    getMySettings(apiConfig.doctorId).then((settings) => {
      // Merge backend settings with local state
    });
  }
}, [apiConfig.doctorId]);

// On save, persist to backend
const handleSave = useCallback(async () => {
  await update({ wordTimestamps, noiseCancellation, vadEnabled, vadModel, diarizationLocal });
  // Also persist to backend
  if (apiConfig.doctorId) {
    await create({
      userId: apiConfig.doctorId,
      tenantId: apiConfig.tenantId,
      key: 'transcription-options',
      value: JSON.stringify({ wordTimestamps, noiseCancellation, vadEnabled, vadModel, diarizationLocal }),
    });
  }
}, [/* deps */]);
```

2. Verify build succeeds

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx
git commit -m "feat(vite-app): persist user settings to backend via useUserSettings (F1-07, F1-08)"
```

---

# Workstream C: FEAT-02 Transcription Gaps (Parallel)

**Assignee**: Engineer 3
**Estimated Time**: ~1.5 hours
**Branch**: `feat/task-034-feat02-transcription-gaps`
**Depends On**: Workstream A (Toast)

---

## Task C1: Add job elapsed time display to JobProgressTracker

**Files**:
- Modify: `VITE/components/job-progress-tracker.tsx`
- Test: `VITE/components/__tests__/job-progress-tracker.test.tsx` (add test case)

**Steps**:

1. Write failing test

```typescript
// Add to existing or create new test file
describe('JobProgressTracker - Elapsed Time', () => {
  it('displays elapsed time when job has createdAt', () => {
    const job = {
      id: 'job-1',
      status: 'processing',
      createdAt: new Date(Date.now() - 45000).toISOString(), // 45 seconds ago
    };
    render(<JobProgressTracker job={job} />);
    expect(screen.getByText(/elapsed/i)).toBeInTheDocument();
  });

  it('displays total duration when job is completed', () => {
    const created = new Date(Date.now() - 60000);
    const completed = new Date(Date.now() - 5000);
    const job = {
      id: 'job-1',
      status: 'completed',
      createdAt: created.toISOString(),
      completedAt: completed.toISOString(),
    };
    render(<JobProgressTracker job={job} />);
    expect(screen.getByText(/completed in/i)).toBeInTheDocument();
  });
});
```

2. Add elapsed time calculation and display to the component

```typescript
// Inside JobProgressTracker, add:
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// In the render, after the status badge:
{job.createdAt && job.status !== 'completed' && (
  <span className="text-xs text-muted-foreground">
    Elapsed: {formatDuration(Date.now() - new Date(job.createdAt).getTime())}
  </span>
)}
{job.completedAt && job.createdAt && (
  <span className="text-xs text-green-600">
    Completed in {formatDuration(new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime())}
  </span>
)}
```

3. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/components/__tests__/job-progress-tracker.test.tsx
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/job-progress-tracker.tsx
git commit -m "feat(vite-app): add elapsed time display to JobProgressTracker (F2-04)"
```

---

## Task C2: Add VAD indicator to RecordingControls

**Files**:
- Modify: `VITE/components/recording-controls.tsx`

**Steps**:

1. Add a VAD speaking indicator next to the sound level meter

```typescript
// Add to RecordingControls props or derive from useArca audio state:
// The audio.isSpeaking boolean from useArca indicates VAD state

// In the render, add after the sound level meter:
<div className="flex items-center gap-2">
  <div
    className={cn(
      'h-3 w-3 rounded-full transition-colors',
      isSpeaking ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30',
    )}
  />
  <span className="text-xs text-muted-foreground">
    {isSpeaking ? 'Speaking' : 'Silence'}
  </span>
</div>
```

2. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/recording-controls.tsx
git commit -m "feat(vite-app): add VAD speaking indicator to recording controls (F2-03)"
```

---

# Workstream D: FEAT-03 Summarization Gaps (Parallel)

**Assignee**: Engineer 4
**Estimated Time**: ~1 hour
**Branch**: `feat/task-034-feat03-summarization-gaps`
**Depends On**: Workstream A (Toast)

---

## Task D1: Add consultation link after job completion in Summarization page

**Files**:
- Modify: `VITE/pages/summarization.tsx`

**Steps**:

1. After a summarization job completes (both streaming and polling tabs), show a link/badge indicating the context item was created

```typescript
// In the PollingTab, after job completion display:
{jobCompleted && consultationId && (
  <Card className="border-green-500/50 bg-green-50 dark:bg-green-950/20">
    <CardContent className="flex items-center gap-3 py-3">
      <CheckCircle className="h-5 w-5 text-green-600" />
      <div>
        <p className="text-sm font-medium">Summary added to consultation</p>
        <p className="text-xs text-muted-foreground">
          Context item linked to consultation {consultationId}
        </p>
      </div>
    </CardContent>
  </Card>
)}
```

2. Add elapsed time display using the same pattern from Task C1

3. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/pages/summarization.tsx
git commit -m "feat(vite-app): add consultation link and elapsed time after summarization (F3-02, F3-03)"
```

---

# Workstream E: FEAT-04 Admin Gaps (Parallel)

**Assignee**: Engineer 5
**Estimated Time**: ~2 hours
**Branch**: `feat/task-034-feat04-admin-gaps`
**Depends On**: Workstream A (ConfirmDialog, Pagination, Toast)

---

## Task E1: Add API key usage statistics to Users tab

**Files**:
- Modify: `VITE/components/admin/users-tab.tsx`

**Steps**:

1. In the expandable API keys section of each user row, call `getUsage(keyId)` and display stats

```typescript
// Inside the API key expansion section, add:
const { getUsage } = useApiKeys();
const [usage, setUsage] = useState<Record<string, ApiKeyUsage>>({});

const loadUsage = useCallback(async (keyId: string) => {
  const data = await getUsage(keyId);
  setUsage((prev) => ({ ...prev, [keyId]: data }));
}, [getUsage]);

// In the API key list render, after the key info:
{usage[key.id] && (
  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
    <div>
      <span className="text-muted-foreground">Total Calls</span>
      <p className="font-medium">{usage[key.id].totalCalls}</p>
    </div>
    <div>
      <span className="text-muted-foreground">Last Used</span>
      <p className="font-medium">{usage[key.id].lastUsedAt ? new Date(usage[key.id].lastUsedAt).toLocaleDateString() : 'Never'}</p>
    </div>
    <div>
      <span className="text-muted-foreground">Rate Limit</span>
      <p className="font-medium">{usage[key.id].rateLimitRemaining}/{usage[key.id].rateLimitTotal}</p>
    </div>
  </div>
)}
```

2. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/admin/users-tab.tsx
git commit -m "feat(vite-app): add API key usage statistics display (F4-01)"
```

---

## Task E2: Add ConfirmDialog to all delete operations in admin tabs

**Files**:
- Modify: `VITE/components/admin/users-tab.tsx`
- Modify: `VITE/components/admin/prompts-tab.tsx`
- Modify: `VITE/components/admin/models-tab.tsx`
- Modify: `VITE/components/admin/departments-tab.tsx`
- Modify: `VITE/components/admin/storage-tab.tsx`

**Steps**:

1. Import `ConfirmDialog` in each admin tab

```typescript
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
```

2. Replace direct delete button `onClick` handlers with `ConfirmDialog` wrappers

```typescript
// Before:
<Button variant="ghost" size="icon" onClick={() => handleDelete(item.id)}>
  <Trash2 className="h-4 w-4" />
</Button>

// After:
<ConfirmDialog
  title={`Delete ${item.name}?`}
  description="This action cannot be undone. The item will be permanently removed."
  onConfirm={() => handleDelete(item.id)}
  trigger={
    <Button variant="ghost" size="icon">
      <Trash2 className="h-4 w-4 text-destructive" />
    </Button>
  }
/>
```

3. Apply the same pattern to all 5 admin tab files

4. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/admin/
git commit -m "feat(vite-app): add confirmation dialogs to all admin delete operations (X-05)"
```

---

## Task E3: Add Pagination to admin list views

**Files**:
- Modify: `VITE/components/admin/users-tab.tsx`
- Modify: `VITE/components/admin/prompts-tab.tsx`
- Modify: `VITE/components/admin/models-tab.tsx`
- Modify: `VITE/components/admin/departments-tab.tsx`
- Modify: `VITE/components/admin/storage-tab.tsx`

**Steps**:

1. Import Pagination component

```typescript
import { Pagination } from '@/components/ui/pagination';
```

2. Add pagination state and pass to SDK list methods

```typescript
const PAGE_SIZE = 10;
const [currentPage, setCurrentPage] = useState(1);

// In the list fetch call:
const result = await list({ page: currentPage, limit: PAGE_SIZE });
const totalPages = Math.ceil(result.total / PAGE_SIZE);

// After the table/list render:
<Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
```

3. Apply to all 5 admin tabs

4. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/admin/
git commit -m "feat(vite-app): add pagination to all admin list views (X-06)"
```

---

## Task E4: Add Toast notifications to admin CRUD operations

**Files**:
- Modify: `VITE/components/admin/users-tab.tsx`
- Modify: `VITE/components/admin/prompts-tab.tsx`
- Modify: `VITE/components/admin/models-tab.tsx`
- Modify: `VITE/components/admin/departments-tab.tsx`
- Modify: `VITE/components/admin/storage-tab.tsx`

**Steps**:

1. Import useToast in each admin tab

```typescript
import { useToast } from '@/lib/use-toast';
```

2. Add toast calls after successful operations

```typescript
const { toast } = useToast();

// After successful create:
toast({ title: 'User created', description: `${user.name} has been added`, variant: 'success' });

// After successful delete:
toast({ title: 'User deleted', description: `${user.name} has been removed`, variant: 'success' });

// After error:
toast({ title: 'Operation failed', description: error.message, variant: 'destructive' });
```

3. Apply to all 5 admin tabs

4. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

5. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/admin/
git commit -m "feat(vite-app): add toast notifications to admin CRUD operations (X-04)"
```

---

# Workstream F: FEAT-05 DNA Style Gaps (Parallel)

**Assignee**: Engineer 6
**Estimated Time**: ~2 hours
**Branch**: `feat/task-034-feat05-dna-style-gaps`
**Depends On**: Workstream A (VerticalStepper)

---

## Task F1: Refactor DNA Style page to use VerticalStepper

**Files**:
- Modify: `VITE/pages/dna-style.tsx`
- Test: `VITE/pages/__tests__/dna-style.test.tsx` (add test case)

**Steps**:

1. Write failing test

```typescript
describe('DNA Style Page - Vertical Stepper', () => {
  it('renders vertical stepper with 5 steps', () => {
    // render DnaStylePage with mocked providers
    // expect 5 step indicators to be present
    const stepIndicators = screen.getAllByTestId(/^step-indicator-/);
    expect(stepIndicators).toHaveLength(5);
  });

  it('shows first step as active initially', () => {
    // render DnaStylePage
    const firstStep = screen.getByTestId('step-indicator-select');
    expect(firstStep.getAttribute('data-status')).toBe('active');
  });
});
```

2. Import and use VerticalStepper

```typescript
import { VerticalStepper, type StepConfig } from '@/components/ui/vertical-stepper';

const DNA_STEPS: StepConfig[] = [
  { id: 'select', label: 'Select Consultation', description: 'Choose a consultation with at least one summary' },
  { id: 'review', label: 'Review Summary', description: 'Edit the raw summary for DNA generation' },
  { id: 'existing', label: 'Existing DNA Report', description: 'View the current DNA writing style report' },
  { id: 'prompt', label: 'Select Prompt & Generate', description: 'Choose a generation prompt and submit' },
  { id: 'results', label: 'Results', description: 'View the generated DNA writing style report' },
];

// Replace the existing step-based layout with:
<VerticalStepper steps={DNA_STEPS} currentStep={currentStep}>
  {currentStep === 0 && <ConsultationSelector ... />}
  {currentStep === 1 && <SummaryEditor ... />}
  {currentStep === 2 && <ExistingDnaDisplay ... />}
  {currentStep === 3 && <PromptSelectorAndGenerate ... />}
  {currentStep === 4 && <ResultsDisplay ... />}
</VerticalStepper>
```

3. Verify test passes

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vitest run --reporter=verbose src/pages/__tests__/dna-style.test.tsx
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx
git commit -m "feat(vite-app): refactor DNA Style page to use VerticalStepper (F5-01)"
```

---

## Task F2: Add DNA-specific status bar with job count and report count

**Files**:
- Modify: `VITE/pages/dna-style.tsx`

**Steps**:

1. Add a status section showing running jobs and total reports

```typescript
// At the top of the page, add a DNA-specific status bar:
function DnaStatusBar() {
  const { style } = useDnaStyle();
  const monitoring = useMonitoring();

  return (
    <div className="mb-6 flex items-center gap-6 rounded-lg border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm">
          Running Jobs: <strong>{monitoring.sessions?.activeDnaJobs ?? 0}</strong>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm">
          Total Reports: <strong>{style ? 1 : 0}</strong>
        </span>
      </div>
    </div>
  );
}
```

2. Verify build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx
git commit -m "feat(vite-app): add DNA-specific status bar with job/report counts (F5-02, F5-03)"
```

---

# Workstream G: Cross-Cutting UX Improvements (Parallel)

**Assignee**: Engineer 7
**Estimated Time**: ~1.5 hours
**Branch**: `feat/task-034-cross-cutting-ux`
**Depends On**: Workstream A

---

## Task G1: Add Tailwind dark mode support

**Files**:
- Modify: `VITE/index.css` (or `globals.css`)

**Steps**:

1. Ensure Tailwind CSS 4 dark mode is configured. Add dark mode CSS variables:

```css
/* Add to the existing CSS file */
.dark {
  --background: 224 71% 4%;
  --foreground: 213 31% 91%;
  --card: 224 71% 4%;
  --card-foreground: 213 31% 91%;
  --popover: 224 71% 4%;
  --popover-foreground: 213 31% 91%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 222.2 47.4% 11.2%;
  --secondary-foreground: 210 40% 98%;
  --muted: 223 47% 11%;
  --muted-foreground: 215.4 16.3% 56.9%;
  --accent: 216 34% 17%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 63% 31%;
  --destructive-foreground: 210 40% 98%;
  --border: 216 34% 17%;
  --input: 216 34% 17%;
  --ring: 216 34% 17%;
}
```

2. Verify dark mode renders correctly

```bash
cd packages/agentic-sdk-v2/examples/vite-app && npx vite build --mode development 2>&1 | tail -5
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/
git commit -m "feat(vite-app): add Tailwind dark mode CSS variables (U-03)"
```

---

## Task G2: Add React Error Boundary

**Files**:
- Create: `VITE/components/error-boundary.tsx`

**Steps**:

1. Create ErrorBoundary component

```typescript
// VITE/components/error-boundary.tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
          <AlertCircle className="h-12 w-12 text-destructive" />
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <Button onClick={() => this.setState({ hasError: false, error: null })}>
            <RefreshCw className="mr-2 h-4 w-4" /> Try Again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

2. Wrap routes in App.tsx with ErrorBoundary

```typescript
// In App.tsx, wrap the Routes component:
import { ErrorBoundary } from '@/components/error-boundary';

// <ErrorBoundary>
//   <Routes>...</Routes>
// </ErrorBoundary>
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/vite-app/src/components/error-boundary.tsx packages/agentic-sdk-v2/examples/vite-app/src/App.tsx
git commit -m "feat(vite-app): add React ErrorBoundary for unhandled errors (X-02)"
```

---

# Workstream H: Next.js App Parity (Parallel)

**Assignee**: Engineer 8
**Estimated Time**: ~3 hours
**Branch**: `feat/task-034-nextjs-parity`
**Depends On**: Workstream A (all shared components must be ported)

This workstream ports all Workstream A-G changes to the Next.js app. Since both apps share the same component patterns, this is primarily a copy-and-adapt task.

---

## Task H1: Port ThemeProvider and ThemeToggle to Next.js app

**Files**:
- Create: `NEXT/components/theme-provider.tsx`
- Create: `NEXT/components/ui/theme-toggle.tsx`
- Modify: `NEXT/app/layout.tsx`
- Modify: `NEXT/components/navigation.tsx`

**Steps**:

1. Copy `theme-provider.tsx` from vite-app, ensure `'use client'` directive is present
2. Copy `ui/theme-toggle.tsx` from vite-app, ensure `'use client'` directive is present
3. Wrap `layout.tsx` children with `<ThemeProvider>`
4. Add `<ThemeToggle />` to navigation component
5. Add dark mode CSS variables to `globals.css`

```bash
# Verify build
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

6. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/
git commit -m "feat(nextjs-app): port ThemeProvider and ThemeToggle (U-03, F1-01)"
```

---

## Task H2: Port VerticalStepper, ConfirmDialog, Pagination, Toast to Next.js

**Files**:
- Create: `NEXT/components/ui/vertical-stepper.tsx`
- Create: `NEXT/components/ui/confirm-dialog.tsx`
- Create: `NEXT/components/ui/pagination.tsx`
- Create: `NEXT/components/ui/toast.tsx`
- Create: `NEXT/lib/use-toast.ts`

**Steps**:

1. Copy each component from vite-app, adding `'use client'` directive where needed
2. Ensure all imports use Next.js path aliases (`@/`)
3. Integrate ToastProvider into the layout or providers component

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/
git commit -m "feat(nextjs-app): port shared UI components from vite-app"
```

---

## Task H3: Port Setup page transcription options to Next.js

**Files**:
- Modify: `NEXT/app/setup/_content.tsx`

**Steps**:

1. Add the `TranscriptionOptionsCard` component (same as Task B1) to the setup page
2. Add backend persistence via `useUserSettings` (same as Task B2)
3. Verify build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/app/setup/_content.tsx
git commit -m "feat(nextjs-app): add transcription options to setup page (F1-02..F1-08)"
```

---

## Task H4: Port Transcription page improvements to Next.js

**Files**:
- Modify: `NEXT/components/job-progress-tracker.tsx`
- Modify: `NEXT/components/recording-controls.tsx`

**Steps**:

1. Add elapsed time display to JobProgressTracker (same as Task C1)
2. Add VAD indicator to RecordingControls (same as Task C2)
3. Verify build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/components/
git commit -m "feat(nextjs-app): port transcription improvements (F2-03, F2-04)"
```

---

## Task H5: Port Summarization improvements to Next.js

**Files**:
- Modify: `NEXT/app/summarization/_content.tsx`

**Steps**:

1. Add consultation link after job completion (same as Task D1)
2. Verify build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/app/summarization/_content.tsx
git commit -m "feat(nextjs-app): port summarization improvements (F3-02, F3-03)"
```

---

## Task H6: Port Admin improvements to Next.js

**Files**:
- Modify: `NEXT/components/admin/users-tab.tsx`
- Modify: `NEXT/components/admin/prompts-tab.tsx`
- Modify: `NEXT/components/admin/models-tab.tsx`
- Modify: `NEXT/components/admin/departments-tab.tsx`
- Modify: `NEXT/components/admin/storage-tab.tsx`

**Steps**:

1. Add API key usage statistics (same as Task E1)
2. Add ConfirmDialog to all delete operations (same as Task E2)
3. Add Pagination to all list views (same as Task E3)
4. Add Toast notifications to all CRUD operations (same as Task E4)
5. Verify build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

6. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/components/admin/
git commit -m "feat(nextjs-app): port admin improvements (F4-01, X-04, X-05, X-06)"
```

---

## Task H7: Port DNA Style VerticalStepper to Next.js

**Files**:
- Modify: `NEXT/app/dna-style/_content.tsx`

**Steps**:

1. Refactor to use VerticalStepper (same as Task F1)
2. Add DNA-specific status bar (same as Task F2)
3. Verify build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

4. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/app/dna-style/_content.tsx
git commit -m "feat(nextjs-app): port DNA Style stepper and status bar (F5-01, F5-02, F5-03)"
```

---

## Task H8: Add ErrorBoundary to Next.js app

**Files**:
- Create: `NEXT/components/error-boundary.tsx`
- Create: `NEXT/app/error.tsx` (Next.js error boundary convention)

**Steps**:

1. Create `error.tsx` following Next.js App Router convention

```typescript
// NEXT/app/error.tsx
'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
      <AlertCircle className="h-12 w-12 text-destructive" />
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="max-w-md text-center text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={reset}>
        <RefreshCw className="mr-2 h-4 w-4" /> Try Again
      </Button>
    </div>
  );
}
```

2. Verify build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && npx next build 2>&1 | tail -10
```

3. Commit

```bash
git add packages/agentic-sdk-v2/examples/nextjs-app/src/app/error.tsx
git commit -m "feat(nextjs-app): add Next.js error boundary (X-02)"
```

---

# Implementation Summary

## Task Count by Workstream

| Workstream | Tasks | Engineer | Est. Time | Dependencies |
|------------|-------|----------|-----------|--------------|
| A: Shared Infrastructure | A1-A8 (8 tasks) | Engineer 1 | ~2h | None |
| B: FEAT-01 Setup | B1-B2 (2 tasks) | Engineer 2 | ~2h | A |
| C: FEAT-02 Transcription | C1-C2 (2 tasks) | Engineer 3 | ~1.5h | A |
| D: FEAT-03 Summarization | D1 (1 task) | Engineer 4 | ~1h | A |
| E: FEAT-04 Admin | E1-E4 (4 tasks) | Engineer 5 | ~2h | A |
| F: FEAT-05 DNA Style | F1-F2 (2 tasks) | Engineer 6 | ~2h | A |
| G: Cross-Cutting UX | G1-G2 (2 tasks) | Engineer 7 | ~1.5h | A |
| H: Next.js Parity | H1-H8 (8 tasks) | Engineer 8 | ~3h | A-G |
| **Total** | **29 tasks** | **8 engineers** | **~15h** | |

## Parallel Execution Timeline

```
Hour 0-2:   [Engineer 1: Workstream A] ─────────────────────────────────►
Hour 2-4:   [Engineer 2: Workstream B] ──────────────►
            [Engineer 3: Workstream C] ────────────►
            [Engineer 4: Workstream D] ──────►
            [Engineer 5: Workstream E] ──────────────►
            [Engineer 6: Workstream F] ──────────────►
            [Engineer 7: Workstream G] ────────────►
Hour 2-5:   [Engineer 8: Workstream H] ──────────────────────────────────►
```

**Critical path**: A → H (5 hours with full parallelism)
**Total wall-clock time with 8 engineers**: ~5 hours
**Total wall-clock time with 2 engineers**: ~8-10 hours

## Gap Coverage Matrix

| Gap ID | Description | Workstream | Task |
|--------|-------------|------------|------|
| F1-01 | Theme switcher | A | A1, A2, A7, A8 |
| F1-02 | Word-level timestamp toggle | B | B1 |
| F1-03 | Noise cancellation selector | B | B1 |
| F1-04 | VAD model selector | B | B1 |
| F1-05 | Diarization local toggle | B | B1 |
| F1-07 | Settings persistence to backend | B | B2 |
| F1-08 | Settings fetch on load | B | B2 |
| F2-03 | VAD speaking indicator | C | C2 |
| F2-04 | Job elapsed time display | C | C1 |
| F3-02 | Job completion time | D | D1 |
| F3-03 | Summary context item linking | D | D1 |
| F4-01 | API key usage statistics | E | E1 |
| F5-01 | Vertical stepper | A+F | A3, F1 |
| F5-02 | Running DNA jobs count | F | F2 |
| F5-03 | Total DNA reports count | F | F2 |
| U-03 | Dark mode support | G | G1 |
| X-02 | Error boundary | G+H | G2, H8 |
| X-04 | Toast notifications | A+E | A6, E4 |
| X-05 | Confirmation dialogs | A+E | A4, E2 |
| X-06 | Pagination UI | A+E | A5, E3 |

## Out of Scope (Deferred)

| Gap ID | Description | Reason |
|--------|-------------|--------|
| F1-06 | Voice embedding | Blocked by TASK-033 |
| F2-01 | CPU/GPU resource display | Requires new backend endpoint |
| X-01 | Authentication/login flow | Separate TASK recommended |
| S-01..S-12 | SDK hook gaps | Separate SDK enhancement TASK |
| U-01 | Shared component package | Architectural decision needed |

---

## Change History

### Implementation Notes — Workstream E: FEAT-04 Admin Gaps (2026-02-20)

All 4 tasks completed using strict TDD (Red-Green-Refactor). Total: 84 tests passing across 6 test files.

#### E1: API Key Usage Statistics (F4-01)
- **Files modified**: `VITE/components/admin/users-tab.tsx`, `VITE/components/admin/__tests__/users-tab.test.tsx`
- Added `ApiKeyUsage` interface and `usageMap` state to `UserRow`
- `getUsage()` is called for each API key when a user row is expanded
- Displays Total Calls, Last Used date, and Rate Limit (remaining/total) per key
- Tests: 1 new test added (13 → 16 total for users-tab)

#### E2: ConfirmDialog for Delete Operations (X-05)
- **Files modified**: All 5 admin tabs + their test files
- Replaced `window.confirm()` in prompts-tab and storage-tab with `ConfirmDialog`
- Replaced inline card confirmations in models-tab and departments-tab with `ConfirmDialog`
- users-tab already had proper AlertDialog (unchanged)
- Tests: 4 new tests added across 4 tab test files

#### E3: Pagination for All Admin List Views (X-06)
- **Files modified**: All 5 admin tabs + their test files
- Added `PAGE_SIZE = 10` constant and `currentPage` state to each tab
- Paginated data arrays before rendering (filteredUsers, prompts, filteredModels, allDepts, files)
- Added `<Pagination>` component below each list/table
- Reset to page 1 on search/filter changes and bucket selection
- Tests: 5 new tests added (one per tab)

#### E4: Toast Notifications for CRUD Operations (X-04)
- **Files modified**: All 5 admin tabs + their test files, created `VITE/lib/use-toast.ts`
- Created missing `lib/use-toast.ts` (ToastContext, useToast hook)
- Added `useToast()` to all 5 admin tabs
- Toast calls after: create, update, delete operations in each tab
- Also added toasts for: upload (storage), status update (models), prompt config save (departments)
- Tests: 5 new tests added (one per tab)

### Implementation Notes — Workstream H: Next.js App Parity (2026-02-20)

All 8 tasks completed. Next.js app now has full feature parity with the Vite app. Build passes (`next build` exit code 0).

#### H1: ThemeProvider and ThemeToggle
- **Files created**: `NEXT/components/theme-provider.tsx`, `NEXT/components/ui/theme-toggle.tsx`
- **Files modified**: `NEXT/app/layout.tsx`, `NEXT/components/navigation.tsx`
- Ported ThemeProvider with localStorage persistence and `'use client'` directive
- Wrapped layout with `<ThemeProvider>` and `<ToastProvider>`
- Added `<ThemeToggle />` to navigation bar
- Dark mode CSS variables already present in `globals.css`

#### H2: Shared UI Components (VerticalStepper, ConfirmDialog, Pagination, Toast)
- **Files created**: `NEXT/components/ui/vertical-stepper.tsx`, `NEXT/components/ui/confirm-dialog.tsx`, `NEXT/components/ui/pagination.tsx`, `NEXT/components/ui/toast.tsx`, `NEXT/lib/use-toast.ts`
- All components ported with `'use client'` directives
- Installed `@radix-ui/react-alert-dialog` dependency for ConfirmDialog

#### H3: Setup Page Transcription Options (Already Present)
- Next.js setup page already included transcription options (word-level timestamps, noise cancellation, VAD model selector, speaker embedding) in the `PersonalizationCard`
- Backend persistence via `useUserSettings` and `useGlobalSettings` already integrated

#### H4: Transcription Page Improvements (Already Present)
- `JobProgressTracker` already had elapsed time display with `formatElapsed` helper
- `RecordingControls` already had VAD speaking indicator badge

#### H5: Summarization Improvements
- **Files modified**: `NEXT/app/summarization/_content.tsx`
- Added `formatDuration` helper and `ConsultationLinkCard` component
- Added timing state (`streamStartedAt`, `streamCompletedAt`) to StreamingTab
- Rendered `ConsultationLinkCard` after completion in both StreamingTab and PollingTab

#### H6: Admin Improvements
- **Files modified**: All 5 admin tabs (`users-tab.tsx`, `prompts-tab.tsx`, `models-tab.tsx`, `departments-tab.tsx`, `storage-tab.tsx`)
- Added `ConfirmDialog` to all delete operations
- Added `Pagination` (PAGE_SIZE=10) to all list views
- Added `useToast` notifications for all CRUD operations (create, update, delete, upload)

#### H7: DNA Style VerticalStepper
- **Files modified**: `NEXT/app/dna-style/_content.tsx`
- Added `VerticalStepper` with 5-step DNA workflow
- Added `DnaStatusBar` showing status and DNA report count
- Replaced custom step component with shared `VerticalStepper`

#### H8: ErrorBoundary
- **Files created**: `NEXT/app/error.tsx`, `NEXT/components/error-boundary.tsx`
- `error.tsx` follows Next.js App Router convention with `reset` callback
- `ErrorBoundary` class component for wrapping individual sections

#### SDK Export Fixes (Prerequisite)
- Added `useHealthCheck`, `useGlobalSettings`, `useUserSettings` to SDK hooks index and core exports
- Added `Bucket`, `StorageFile`, `StorageFileWithUrl` type exports from storage hook
- Rebuilt SDK to include all new exports

---

## Execution Handoff

### Option 1: Subagent-Driven (Current Session)

Use the `executing-plans` skill for automated execution:
- Fresh agent per task
- Code review between tasks
- Quality gates at each commit

### Option 2: Parallel Session (Separate Worktrees)

Each engineer creates a git worktree for their branch:

```bash
git worktree add ../task-034-ws-a feat/task-034-shared-infrastructure
git worktree add ../task-034-ws-b feat/task-034-feat01-setup-gaps
git worktree add ../task-034-ws-c feat/task-034-feat02-transcription-gaps
# ... etc
```

Engineers follow tasks sequentially within their workstream, committing after each task. Workstream H engineer waits for A-G branches to merge before starting.

---

### Update 1 — Post-Implementation Bug Fixes & Enhancements (2026-02-20)

**Scope**: Fix all 15 issues identified in the post-implementation code review.

#### Critical Fix
| # | Issue | Files Modified | Fix |
|---|-------|---------------|-----|
| 1 | **completedAt infinite re-render** — `new Date()` created on every render in `JobProgressTracker` | `VITE/pages/transcription.tsx`, `NEXT/app/transcription/_content.tsx` | Added `jobCompletedAt` state + `useRef` to capture completion time once on status transition |

#### Recommendations Fixed
| # | Issue | Files Modified | Fix |
|---|-------|---------------|-----|
| 2 | Disconnected dual controls in PersonalizationCard (word timestamps, speaker embedding toggles duplicated from TranscriptionOptionsCard) | `VITE/pages/setup.tsx`, `NEXT/app/setup/_content.tsx` | Removed standalone toggles from PersonalizationCard; added reference text pointing to TranscriptionOptionsCard |
| 3 | NER model mislabeled as "Noise Cancellation Model" | `VITE/pages/setup.tsx`, `NEXT/app/setup/_content.tsx` | Changed label to "NER Model" |
| 4 | API key usage stats layout — grid inside flex parent caused side-by-side rendering instead of stacked | `VITE/components/admin/users-tab.tsx`, `NEXT/components/admin/users-tab.tsx` | Restructured: outer div is block layout, inner header is flex, usage stats grid is below with `border-t pt-2` |
| 5 | Missing page reset on filter change in admin tabs | `VITE/components/admin/models-tab.tsx`, `VITE/components/admin/prompts-tab.tsx`, `NEXT/…` (same) | Added `useEffect(() => setCurrentPage(1), [filters])` and removed `setCurrentPage` from inside `useMemo` |
| 6 | Unsafe `localStorage` cast — `as Theme` could accept invalid values | `VITE/components/theme-provider.tsx`, `NEXT/components/theme-provider.tsx` | Added `isValidTheme()` guard function, validate stored value before using |
| 7 | Toast `setTimeout` leak — timers not cleared on unmount or dismiss | `VITE/components/ui/toast.tsx`, `NEXT/components/ui/toast.tsx` | Added `useRef<Map<string, Timer>>` to track timer IDs; cleanup on unmount + on manual dismiss |
| 9 | Static upload progress bar (`Progress value={50}`) | `VITE/components/admin/storage-tab.tsx`, `NEXT/components/admin/storage-tab.tsx` | Added `uploadedCount`/`uploadTotalCount` state, computed real percentage, display file counter |

#### Suggestions Fixed
| # | Issue | Files Modified | Fix |
|---|-------|---------------|-----|
| 10 | `'use client'` directive in vite-app files | `VITE/components/theme-provider.tsx`, `VITE/components/ui/toast.tsx` | Removed (vite-app doesn't use RSC; directive is a no-op) |
| 12 | Inconsistent `<input>` vs `<Input>` in admin tabs | `VITE/components/admin/{models,departments}-tab.tsx`, `NEXT/…`, new `VITE/components/ui/input.tsx`, `NEXT/components/ui/input.tsx` | Created reusable `Input` component, replaced all raw `<input>` elements |
| 13 | Missing `eslint-disable` for intentionally empty dependency arrays | `VITE/pages/transcription.tsx`, `VITE/components/admin/{models,prompts,storage}-tab.tsx`, `NEXT/…` (same) | Added `// eslint-disable-next-line react-hooks/exhaustive-deps` |
| 14-15 | DNA running jobs used non-existent `activeDnaJobs` field; total reports hardcoded to `style ? 1 : 0` | `VITE/pages/dna-style.tsx`, `NEXT/app/dna-style/_content.tsx` | Use `sessions.processingJobs` for running jobs; use `reports.length` when array is available |

#### Enhancement
| # | Issue | Files Modified | Fix |
|---|-------|---------------|-----|
| — | Next.js setup page missing `TranscriptionOptionsCard` (parity gap) | `NEXT/app/setup/_content.tsx` | Added `TranscriptionOptionsCard` component with `Switch` controls + `useUserSettings` persistence |

#### Not Changed (Confirmed Correct)
| # | Issue | Reason |
|---|-------|--------|
| 8 | `Providers` vs `LazyProviders` in Next.js DNA style | DNA style correctly uses eager `Providers` per the documented guidance (no STT/VAD/audio needed) |
