module.exports = {
  apps: [
    {
      name: 'api',
      cwd: './apps/api',
      script: 'pnpm dev',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
    },
    {
      name: 'tts',
      cwd: './apps/tts',
      script: 'python3 src/server.py',
      interpreter: './apps/tts/.venv/bin/python',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
    }
  ],
};