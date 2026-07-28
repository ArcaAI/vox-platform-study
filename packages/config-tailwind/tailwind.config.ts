import type { Config } from 'tailwindcss';

const sharedConfig: Omit<Config, 'content'> = {
  theme: {
    extend: {},
  },
  plugins: [],
};

export default sharedConfig;
