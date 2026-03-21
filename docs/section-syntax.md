## Section, Example & Tabs Syntax

### What This Does

Lets markdown authors control whether Content/Example tabs appear and exactly which parts of the document belong to each tab. Without markers, markdown renders as plain text with no tabs.

### Markers

| Marker | Purpose |
|--------|---------|
| `<!-- @section -->` | Opens a tabbed block |
| `<!-- @/section -->` | Closes the tabbed block |
| `<!-- @example -->` | Opens the example pane inside a section |
| `<!-- @/example -->` | Closes the example pane |
| `<!-- @tabs -->` | Opens a tabbed code group |
| `<!-- @/tabs -->` | Closes the tabbed code group |

### How It Works

1. Wrap any part of your markdown in `<!-- @section -->` … `<!-- @/section -->`
2. Inside that block, wrap example content in `<!-- @example -->` … `<!-- @/example -->`
3. Text outside the example tags renders in the **Content** tab
4. Text inside the example tags renders in the **Examples** tab
5. Text outside any `<!-- @section -->` block renders as plain markdown (no tabs)
6. Multiple `<!-- @section -->` blocks produce multiple independent tab pairs

### Rules

- If a markdown file has **no** `<!-- @section -->` markers, it renders as plain markdown — no tabs at all
- `<!-- @example -->` … `<!-- @/example -->` is optional inside a section — if omitted, the entire section shows as Content with an empty Examples tab
- If `<!-- @/section -->` is omitted, everything from the opening marker to the end of the file is treated as that section
- If `<!-- @/example -->` is omitted, everything from the opening marker to `<!-- @/section -->` is treated as the example
- Each `<!-- @section -->` block is independent and gets its own Content/Examples tab UI
- Code blocks (triple backticks) inside Content stay in Content — they are not auto-extracted

<!-- @section -->

### Basic Usage

A single section with content and an example.

```markdown
## My Feature

Plain intro text — no tabs here.

<!-- @section -->
### How It Works

This explanation appears in the Content tab.

<!-- @example -->

` ```ts
const feature = createFeature({ enabled: true })
feature.start()
` ```

<!-- @/example -->
<!-- @/section -->
```

<!-- @example -->

```markdown
<!-- @section -->
Content tab text here.

<!-- @example -->
Example tab text here.
<!-- @/example -->

<!-- @/section -->
```

<!-- @/example -->
<!-- @/section -->

<!-- @section -->

### Multiple Sections

Each `<!-- @section -->` block produces its own independent tab pair. Plain markdown can appear between them.

<!-- @example -->

```markdown
## Feature Docs

Intro paragraph — plain markdown, no tabs.

<!-- @section -->
### Configuration

Config explanation in Content tab.

<!-- @example -->

` ```ts
const config = { timeout: 5000 }
` ```

<!-- @/example -->
<!-- @/section -->

Middle paragraph — plain markdown again.

<!-- @section -->
### API Reference

API docs in Content tab.

<!-- @example -->

` ```ts
api.call('endpoint', { method: 'GET' })
` ```

<!-- @/example -->
<!-- @/section -->
```

<!-- @/example -->
<!-- @/section -->

<!-- @section -->

### Tabbed Code Groups

Use `<!-- @tabs -->` … `<!-- @/tabs -->` to render multiple code blocks as a tab group (e.g., pnpm/npm/yarn). Each fenced code block's language identifier becomes the tab label.

<!-- @example -->

```markdown
<!-- @tabs -->
` ```pnpm
pnpm add @arcaai/stt
` ```
` ```npm
npm install @arcaai/stt
` ```
` ```yarn
yarn add @arcaai/stt
` ```
<!-- @/tabs -->
```

<!-- @/example -->
<!-- @/section -->
