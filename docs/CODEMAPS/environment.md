# Environment & Configuration Codemap

**Last Updated:** 2026-03-09

---

## 📋 Purpose

Reference for all environment variables, configuration files, and secrets management across local development and production deployments.

---

## 🌍 Development Environment (.env.local)

### Database (PostgreSQL)
```bash
DATABASE_URL=postgresql://hope_user:hope_password@localhost:5432/hope_db
```

### Cache & Queue (Redis)
```bash
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=redis_password
```

### Object Storage (MinIO)
```bash
MINIO_URL=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=audio-uploads
```

### Vector Database (Qdrant)
```bash
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=medical-documents
```

### API Gateway (NestJS)
```bash
NODE_ENV=development
PORT=3000
JWT_SECRET=dev-secret-change-in-production
JWT_EXPIRES_IN=1h
SESSION_SECRET_KEY=dev-session-secret-change-in-production
```

### Python Services URLs
```bash
STT_V2_URL=http://localhost:8861
SMR_URL=http://localhost:8862
SMR_SERVICE_URL_HTTP=http://localhost:8862
NLP_URL=http://localhost:8864
NLP_SERVICE_URL=http://localhost:8864
NLP_SERVICE_URL_HTTP=http://localhost:8864
```

### Secrets Management (Vault)
```bash
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=myroot
VAULT_NAMESPACE=hope
```

### Python Environment
```bash
CONDA_ENV=arcaenv
PYTHONPATH=${PWD}/apps/stt-v2/src:${PWD}/apps/smr/src:${PWD}/apps/nlp/src
```

---

## 🏢 Production Environment (.env.production)

### Database
```bash
# RDS / Cloud PostgreSQL
DATABASE_URL=postgresql://produser:${DB_PASSWORD}@prod-db.aws.example.com:5432/hope_prod

# Connection pooling
DATABASE_CONNECTION_LIMIT=20
DATABASE_POOL_IDLE_TIMEOUT=60
```

### Cache (Redis Cloud / AWS ElastiCache)
```bash
REDIS_HOST=prod-redis.aws.example.com
REDIS_PORT=6379
REDIS_PASS=${REDIS_PASSWORD}
REDIS_SSL=true
```

### Object Storage (AWS S3)
```bash
# Instead of MinIO, use AWS S3
S3_BUCKET=hope-production
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=${AWS_S3_KEY}
AWS_SECRET_ACCESS_KEY=${AWS_S3_SECRET}

# Or compatible service
MINIO_URL=https://minio.example.com
MINIO_USE_SSL=true
```

### Vector Database (Managed Qdrant)
```bash
QDRANT_URL=https://qdrant.example.com
QDRANT_API_KEY=${QDRANT_API_KEY}
```

### API Gateway
```bash
NODE_ENV=production
PORT=3000
JWT_SECRET=${SECRET_JWT_KEY}
JWT_EXPIRES_IN=24h
SESSION_SECRET_KEY=${SECRET_SESSION_KEY}

# Security headers
SENTRY_DSN=${SECRET_SENTRY_DSN}
SENTRY_ENVIRONMENT=production
```

### LLM Providers (SMR V2)
```bash
# Azure OpenAI
AZURE_OPENAI_KEY=${SECRET_AZURE_OPENAI_KEY}
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_DEPLOYMENT=gpt-4

# Ollama (if self-hosted)
OLLAMA_BASE_URL=https://ollama.example.com
```

### Secrets Management (HashiCorp Vault)
```bash
VAULT_ADDR=https://vault.example.com
VAULT_NAMESPACE=hope-prod
VAULT_TOKEN=${SECRET_VAULT_TOKEN}
VAULT_AUTH_METHOD=jwt

# Or via Kubernetes auth
KE_SERVICE_ACCOUNT=hope-api
```

### Monitoring & Observability
```bash
# Error tracking
SENTRY_DSN=${SECRET_SENTRY_DSN}
SENTRY_TRACE_SAMPLE_RATE=0.1

# APM (New Relic / Datadog)
NEWRELIC_LICENSE_KEY=${SECRET_NR_KEY}
DATADOG_API_KEY=${SECRET_DD_KEY}

# Logging (CloudWatch / ELK)
AWS_CLOUDWATCH_LOG_GROUP=/hope/api
LOG_LEVEL=info
```

---

## 🔑 Secrets Rotation

### Development (Vault)
```bash
# Login
vault login -method=userpass username=hope password=hope

# Store secret
vault kv put secret/hope/api \
  JWT_SECRET=new-secret-key \
  DB_PASSWORD=new-db-password

# Retrieve
vault kv get secret/hope/api
```

### Production (Vault + CI/CD)
```bash
# Never commit secrets to code
# Inject via CI/CD pipeline

# GitHub Actions example
jobs:
  deploy:
    steps:
      - name: Deploy
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          JWT_SECRET: ${{ secrets.JWT_SECRET }}
          AZURE_OPENAI_KEY: ${{ secrets.AZURE_OPENAI_KEY }}
```

### Kubernetes Secrets
```bash
# Create secret
kubectl create secret generic hope-secrets \
  --from-literal=DATABASE_URL=$DATABASE_URL \
  --from-literal=JWT_SECRET=$JWT_SECRET

# Mount in deployment
spec:
  containers:
    - env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: hope-secrets
              key: DATABASE_URL
```

---

## 🔍 Configuration Files

### Root Configuration (.turbo/config.json)
Turborepo build cache configuration

### TypeScript (tsconfig.json)
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@arcaai/*": ["packages/*/src"]
    }
  }
}
```

### ESLint (config-eslint package)
```js
export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/explicit-function-return-types": "warn",
      "no-console": "warn",
    },
  },
];
```

### Tailwind (config-tailwind package)
```js
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

### Vitest (vitest.config.ts)
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
    },
  },
});
```

---

## 🔐 Environment Variable Validation

### Using Pydantic Settings (Python)
```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    redis_host: str
    redis_port: int = 6379
    jwt_secret: str
    
    class Config:
        env_file = ".env.local"
        case_sensitive = False

settings = Settings()  # Validates on load
```

### Using Joi/Zod or Env Validation (Node.js)
```typescript
import { plainToClass } from "class-transformer";
import { validate } from "class-validator";

class EnvironmentVariables {
  @IsString()
  DATABASE_URL!: string;

  @IsOptional()
  @IsNumber()
  PORT?: number;
}

export async function validateEnv(config: Record<string, any>) {
  const env = plainToClass(EnvironmentVariables, config);
  const errors = await validate(env);

  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join("\n")}`);
  }

  return env;
}
```

---

## ✅ Configuration Checklist

### Development Setup
- [ ] Copy `.env.example` to `.env.local`
- [ ] Start Docker Compose: `pnpm docker:dev:up`
- [ ] Validate DB connection: `psql -h localhost -U hope_user`
- [ ] Validate Redis: `redis-cli PING`
- [ ] Initialize DB: `pnpm db:all`
- [ ] Start services: `pnpm dev:api` + `pnpm dev:stt-v2` etc.

### Production Deployment
- [ ] Set all required secrets in Vault/CI
- [ ] Use production database URL
- [ ] Enable HTTPS for all services
- [ ] Configure monitoring (Sentry, Datadog, etc.)
- [ ] Setup log aggregation
- [ ] Enable rate limiting
- [ ] Configure CORS for production domain
- [ ] Set up SSL certificates
- [ ] Enable database backups
- [ ] Configure failover/redundancy

---

## 📊 Reference Table

| Variable | Development | Production | Purpose |
|----------|-------------|-----------|---------|
| `NODE_ENV` | `development` | `production` | Environment flag |
| `DATABASE_URL` | local PostgreSQL | RDS/cloud | Database connection |
| `REDIS_HOST` | localhost | Redis cloud | Cache connection |
| `JWT_SECRET` | dev-secret | $(AWS_SECRETS) | JWT signing |
| `MINIO_URL` | http://localhost:9000 | AWS S3 | Object storage |
| `QDRANT_URL` | http://localhost:6333 | Managed service | Vector DB |
| `SENTRY_DSN` | (optional) | $(VAULT) | Error tracking |

---

## 🔗 Related Documentation

- [Infrastructure Codemap](./infrastructure.md) — Docker and services setup
- [SETUP.md](../../knowledge/SETUP.md) — Complete development setup guide

---

**Status**: ✅ Current | Configuration documented
