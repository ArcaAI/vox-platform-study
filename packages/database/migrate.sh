#!/bin/sh
set -e

echo "Starting database initialization..."

cd /app

echo "Generating Prisma client..."
./packages/database/node_modules/.bin/prisma generate --schema=packages/database/src/prisma/db_main

# Always `migrate deploy`.
#
# This script only ever runs inside the deployed container image, where the
# schema must be applied from reviewed, versioned migrations. The previous
# `NODE_ENV`-switched `db push` branch was unreachable-by-design and reachable-
# in-fact: the k8s Job carries no `NODE_ENV` (no `envFrom` in
# `deployment/k8s/base/db-migrate.yaml`), so `NODE_ENV` was empty and EVERY
# environment — production included — took the `db push` path, which alters the
# schema with no migration record and can drop columns.
#
# `pnpm db:push` remains the right tool for local schema experiments; it is not
# this script's job.
echo "Deploying migrations..."
./packages/database/node_modules/.bin/prisma migrate deploy --schema=packages/database/src/prisma/db_main

# Seeding is OPT-IN.
#
# This invocation used to sit OUTSIDE the environment branch above, so the seed
# ran unconditionally everywhere: fabricated rows upserted into the HIPAA audit
# trail (overwritten on every run) and synthetic PHI written into consultations.
# The migration mechanism was environment-aware; the seed was not.
#
#   RUN_SEED=none  (default) — no seeding, no connection opened
#   RUN_SEED=safe            — platform configuration only; no demo credentials,
#                              no synthetic PHI, no audit-trail writes
#   RUN_SEED=all             — everything; REFUSED unless NODE_ENV is explicitly
#                              development or test
#
# The seed entry point re-validates this itself (`seed-mode.ts`), so the gate
# holds even when the seed is invoked by some other means.
RUN_SEED="${RUN_SEED:-none}"
if [ "$RUN_SEED" = "none" ]; then
  echo "Skipping database seed (RUN_SEED=none)."
else
  echo "Running database seed (RUN_SEED=${RUN_SEED})..."
  ./packages/database/node_modules/.bin/tsx packages/database/dist/index.js
fi

echo "Database initialization completed successfully!"
