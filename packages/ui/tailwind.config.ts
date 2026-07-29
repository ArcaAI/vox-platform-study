import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS v4 Configuration for @arcaai/ui
 *
 * Note: With Tailwind CSS v4, most configuration is done via CSS using @theme directive.
 * This config file is minimal and primarily used for content paths.
 * Theme configuration is in src/styles.css
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // DaisyUI is configured via @plugin directive in styles.css for Tailwind v4
};

export default config;
