#!/bin/sh
set -e

echo "Starting database initialization..."

cd /app

echo "Generating Prisma client..."
./packages/database/node_modules/.bin/prisma generate --schema=packages/database/src/prisma/db_main

if [ "$NODE_ENV" = "production" ] || [ "$NODE_ENV" = "staging" ]; then
  echo "Deploying migrations (${NODE_ENV})..."
  ./packages/database/node_modules/.bin/prisma migrate deploy --schema=packages/database/src/prisma/db_main
else
  echo "Pushing schema (dev mode)..."
  ./packages/database/node_modules/.bin/prisma db push --schema=packages/database/src/prisma/db_main
fi

echo "Running database seed..."
./packages/database/node_modules/.bin/tsx packages/database/dist/index.js

echo "Database initialization completed successfully!"
