#!/bin/sh
set -e

echo "Starting database initialization..."

cd /app

echo "Generating Prisma client..."
./packages/database/node_modules/.bin/prisma generate --schema=packages/database/src/prisma/db_main

echo "Deploying migrations..."
./packages/database/node_modules/.bin/prisma migrate deploy --schema=packages/database/src/prisma/db_main

echo "Running database seed..."
./packages/database/node_modules/.bin/tsx packages/database/dist/index.js

echo "Database initialization completed successfully!"
