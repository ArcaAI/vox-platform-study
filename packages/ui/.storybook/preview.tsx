import type { Preview } from '@storybook/react-vite';

// Import Tailwind CSS styles
import '../src/styles/globals.css';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      disable: true, // We use CSS variables for theming
    },
  },
  globalTypes: {
    theme: {
      description: 'Global theme for components',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme || 'light';

      // Apply theme class to the document
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);

      return (
        <div className={`min-h-screen bg-background text-foreground p-4 ${theme}`}>
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
