# API Gateway Deployment Guide

**Version**: 2.0
**Last Updated**: 2026-02-22
**Audience**: DevOps Engineers, System Administrators, Platform Engineers

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Deployment Options](#deployment-options)
- [Environment Configuration](#environment-configuration)
- [Docker Deployment](#docker-deployment)
- [Single Server Deployment](#single-server-deployment)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Cloud Platform Deployment](#cloud-platform-deployment)
- [Post-Deployment](#post-deployment)
- [Monitoring & Maintenance](#monitoring--maintenance)
- [Troubleshooting](#troubleshooting)
- [Security Hardening](#security-hardening)

---

## Overview

This guide covers deploying the HOPE API Gateway to various environments. The API Gateway is designed as a containerized application that can be deployed to:

- Docker containers
- Single server (systemd-managed)
- Kubernetes clusters
- Cloud platforms (Azure, AWS, GCP)

### Architecture Overview

```
                    ┌─────────────┐
                    │Load Balancer│
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼───┐  ┌─────▼───┐  ┌────▼────┐
        │ API GW  │  │ API GW  │  │ API GW  │
        │Instance1│  │Instance2│  │Instance3│
        └─────┬───┘  └─────┬───┘  └────┬────┘
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
        ┌─────▼─────┐           ┌──────▼────┐
        │PostgreSQL │           │   Redis   │
        │  Cluster  │           │  Cluster  │
        └───────────┘           └───────────┘
```

---

## Prerequisites

### Infrastructure Requirements

#### Minimum Requirements (Single Instance)
- **CPU**: 2 cores
- **RAM**: 4 GB
- **Disk**: 20 GB SSD
- **Network**: 100 Mbps

#### Recommended (Production)
- **CPU**: 4+ cores
- **RAM**: 8+ GB
- **Disk**: 50+ GB SSD
- **Network**: 1 Gbps

### Dependencies

| Service | Version | Purpose |
|---------|---------|---------|
| **PostgreSQL** | 14+ | Primary database |
| **Redis** | 7+ | Cache & session store |
| **Node.js** | 18+ | Runtime (for non-Docker) |
| **Docker** | 20+ | Containerization |
| **Nginx** | Latest | Reverse proxy |

### Network Requirements

**Inbound Ports:**
- `8868` - API Gateway HTTP
- `443` - HTTPS (via reverse proxy)

**Outbound Access:**
- PostgreSQL (typically port 5432)
- Redis (typically port 6379)
- Python microservices (STT=8861, SMR=8862, Guardrail=8863, NLP=8864, Harness=8866)
- External APIs (HTTPS 443)

---

## Deployment Options

### Comparison Matrix

| Option | Complexity | Scalability | Cost | Use Case |
|--------|-----------|-------------|------|----------|
| **Docker** | Low | Medium | Low | Development, Testing |
| **Single Server** | Medium | Low | Low | Small deployments |
| **Kubernetes** | High | High | Medium | Production, Enterprise |
| **Cloud Platforms** | Medium | High | Variable | Production, Auto-scaling |

---

## Environment Configuration

### Environment Variables Reference

Create a `.env` file or set environment variables:

#### Application Settings

```bash
# Environment
NODE_ENV=production                # production | staging | development
PORT=8868                          # API Gateway port
URL=https://api.hope.com          # Public API URL

# Logging
LOG_LEVEL=info                    # error | warn | info | debug
LOG_FILE_ENABLED=true
LOG_FILE_PATH=/var/log/hope/api
LOG_FILE_MAX_SIZE=10m
LOG_FILE_MAX_FILES=1000
```

#### Database Configuration

```bash
# PostgreSQL
DB_CONNECTION_STRING=postgresql://user:password@postgres:5432/hope
DB_CONNECTION_STRING_DIRECT=postgresql://user:password@postgres:5432/hope

# Connection Pool
DB_POOL_MIN=2
DB_POOL_MAX=10
```

#### Redis Configuration

```bash
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASS=your-redis-password
REDIS_TLS=true                    # Enable for production
REDIS_DB=0
```

#### Microservices URLs

```bash
# STT (Speech-to-Text)
STT_PORT=8861
STT_URL=http://stt-service:8861

# SMR (Summarization)
SMR_PORT=8862
SMR_URL=http://smr-service:8862

# Guardrail (Safety Engine)
GUARDRAIL_URL=http://guardrail-service:8863

# NLP (Natural Language Processing)
NLP_PORT=8864
NLP_URL=http://nlp-service:8864

# Harness (Clinical Documentation Harness)
HARNESS_URL=http://harness-service:8866
```

#### Security & Authentication

```bash
# Session Management
SESSION_SECRET_KEY=your-secret-key-min-32-chars

# CORS (comma-separated origins)
CORS_ALLOWED_ORIGINS=https://app.hope.com,https://dashboard.hope.com

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_MS=900000       # 15 minutes
```

#### Monitoring & Observability

```bash
# Sentry (Error Tracking)
SENTRY_DSN_API=https://your-sentry-dsn@sentry.io/project-id

# Highlight (Session Replay)
HIGHLIGHT_PROJECT_ID=your-highlight-project-id
HIGHLIGHT_BACKEND_URL=https://pub.highlight.io
HIGHLIGHT_OTLP_ENDPOINT=https://otel.highlight.io:4318

# OpenTelemetry
OTEL_SERVICE_NAME=hope-api
OTEL_SERVICE_VERSION=1.0.0
OTEL_SERVICE_NAMESPACE=hope
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
```

#### Kafka (Event Streaming)

```bash
KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID=hope-api
KAFKA_GROUP_ID=hope-api-group
```

---

## Docker Deployment

### Build Docker Image

```bash
# From project root
docker build -t hope-api:latest -f apps/api/Dockerfile .

# Build with version tag
docker build -t hope-api:1.0.0 -f apps/api/Dockerfile .
```

### Run with Docker

```bash
# Create network
docker network create hope-network

# Run PostgreSQL
docker run -d --name postgres \
  --network hope-network \
  -e POSTGRES_USER=hope \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=hope \
  -v postgres-data:/var/lib/postgresql/data \
  postgres:17

# Run Redis
docker run -d --name redis \
  --network hope-network \
  -v redis-data:/data \
  redis:8 redis-server --requirepass your-redis-password

# Run API Gateway
docker run -d --name api-gateway \
  --network hope-network \
  -p 8868:8868 \
  -e NODE_ENV=production \
  -e DB_CONNECTION_STRING=postgresql://hope:password@postgres:5432/hope \
  -e REDIS_HOST=redis \
  -e REDIS_PASS=your-redis-password \
  --env-file .env.production \
  hope-api:latest
```

### Docker Compose

See `infrastructure/docker/docker-compose.prod.yml` for complete setup:

```bash
cd infrastructure/docker

# Copy and configure environment
cp env.prod.template .env.prod
# Edit .env.prod with your configuration

# Start all services
docker-compose -f docker-compose.prod.yml up -d

# View logs
docker-compose -f docker-compose.prod.yml logs -f api

# Stop services
docker-compose -f docker-compose.prod.yml down
```

---

## Single Server Deployment

For single-server deployments using systemd.

### 1. System Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
sudo npm install -g pnpm

# Install PostgreSQL
sudo apt install -y postgresql-14

# Install Redis
sudo apt install -y redis-server

# Install Nginx
sudo apt install -y nginx
```

### 2. Application Setup

```bash
# Create application user
sudo useradd -r -s /bin/false hope

# Create directories
sudo mkdir -p /opt/hope/api
sudo mkdir -p /var/log/hope/api
sudo chown -R hope:hope /opt/hope /var/log/hope

# Deploy application
sudo -u hope git clone <repository> /opt/hope/api
cd /opt/hope/api

# Install dependencies
sudo -u hope pnpm install --prod

# Build application
sudo -u hope pnpm build

# Setup database
cd packages/database
sudo -u hope npx prisma migrate deploy
```

### 3. Systemd Service

Create `/etc/systemd/system/hope-api.service`:

```ini
[Unit]
Description=HOPE API Gateway
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=hope
Group=hope
WorkingDirectory=/opt/hope/api/apps/api
EnvironmentFile=/opt/hope/api/apps/api/.env.production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hope-api

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/hope

[Install]
WantedBy=multi-user.target
```

### 4. Start Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service
sudo systemctl enable hope-api

# Start service
sudo systemctl start hope-api

# Check status
sudo systemctl status hope-api

# View logs
sudo journalctl -u hope-api -f
```

### 5. Nginx Configuration

Create `/etc/nginx/sites-available/hope-api`:

```nginx
upstream api_backend {
    least_conn;
    server localhost:8868 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name api.hope.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS Server
server {
    listen 443 ssl http2;
    server_name api.hope.com;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/api.hope.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.hope.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logging
    access_log /var/log/nginx/hope-api-access.log;
    error_log /var/log/nginx/hope-api-error.log;

    # Proxy Settings
    location / {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        proxy_buffering off;
        proxy_request_buffering off;
    }

    # WebSocket Support (STT, NLP)
    location /stt {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    # Health Check (no auth required)
    location /api/v1/health {
        proxy_pass http://api_backend;
        access_log off;
    }

    # Metrics (restrict access)
    location /metrics {
        allow 10.0.0.0/8;      # Internal network
        deny all;
        proxy_pass http://api_backend;
    }
}
```

Enable site:

```bash
sudo ln -s /etc/nginx/sites-available/hope-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Kubernetes Deployment

For production-grade Kubernetes deployment.

### Prerequisites

- Kubernetes cluster (1.24+)
- kubectl configured
- Helm 3+ installed
- Container registry access

### 1. Create Namespace

```bash
kubectl create namespace hope
```

### 2. Create Secrets

```bash
# Database credentials
kubectl create secret generic postgres-credentials \
  --from-literal=username=hope \
  --from-literal=password=your-db-password \
  --namespace=hope

# Redis credentials
kubectl create secret generic redis-credentials \
  --from-literal=password=your-redis-password \
  --namespace=hope

# API Gateway secrets
kubectl create secret generic api-secrets \
  --from-literal=session-secret=your-session-secret \
  --from-literal=sentry-dsn=your-sentry-dsn \
  --namespace=hope
```

### 3. Deploy PostgreSQL

Using Bitnami Helm chart:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami

helm install postgres bitnami/postgresql \
  --namespace hope \
  --set auth.username=hope \
  --set auth.password=your-db-password \
  --set auth.database=hope \
  --set primary.persistence.size=50Gi \
  --set readReplicas.replicaCount=2
```

### 4. Deploy Redis

```bash
helm install redis bitnami/redis \
  --namespace hope \
  --set auth.password=your-redis-password \
  --set master.persistence.size=10Gi \
  --set replica.replicaCount=2
```

### 5. Deploy API Gateway

Create `k8s/api-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: hope
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
      - name: api
        image: your-registry/hope-api:latest
        ports:
        - containerPort: 8868
          name: http
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "8868"
        - name: DB_CONNECTION_STRING
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: connection-string
        - name: REDIS_HOST
          value: "redis-master"
        - name: REDIS_PASS
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: password
        - name: SESSION_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: api-secrets
              key: session-secret
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /api/v1/health/live
            port: 8868
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /api/v1/health/ready
            port: 8868
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: hope
spec:
  type: ClusterIP
  selector:
    app: api-gateway
  ports:
  - port: 80
    targetPort: 8868
    name: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-gateway
  namespace: hope
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - api.hope.com
    secretName: api-tls
  rules:
  - host: api.hope.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-gateway
            port:
              number: 80
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway
  namespace: hope
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

Apply:

```bash
kubectl apply -f k8s/api-deployment.yaml
```

### 6. Verify Deployment

```bash
# Check pods
kubectl get pods -n hope

# Check services
kubectl get svc -n hope

# View logs
kubectl logs -f deployment/api-gateway -n hope

# Check ingress
kubectl get ingress -n hope
```

---

## Cloud Platform Deployment

### Azure Container Apps

```bash
# Create resource group
az group create --name hope-rg --location eastus

# Create container registry
az acr create --resource-group hope-rg \
  --name hoperegistry --sku Basic

# Build and push image
az acr build --registry hoperegistry \
  --image hope-api:latest \
  --file apps/api/Dockerfile .

# Create container app environment
az containerapp env create \
  --name hope-env \
  --resource-group hope-rg \
  --location eastus

# Deploy container app
az containerapp create \
  --name api-gateway \
  --resource-group hope-rg \
  --environment hope-env \
  --image hoperegistry.azurecr.io/hope-api:latest \
  --target-port 8868 \
  --ingress external \
  --min-replicas 2 \
  --max-replicas 10 \
  --env-vars \
    NODE_ENV=production \
    DB_CONNECTION_STRING=secretref:db-connection \
    REDIS_HOST=secretref:redis-host
```

### AWS ECS/Fargate

```bash
# Create ECR repository
aws ecr create-repository --repository-name hope-api

# Build and push image
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

docker build -t hope-api -f apps/api/Dockerfile .
docker tag hope-api:latest <account>.dkr.ecr.us-east-1.amazonaws.com/hope-api:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/hope-api:latest

# Create ECS cluster
aws ecs create-cluster --cluster-name hope-cluster

# Deploy using Fargate (requires task definition and service configuration)
```

---

## Post-Deployment

### Database Migrations

```bash
# Run migrations
cd packages/database
npx prisma migrate deploy

# Verify schema
npx prisma db pull
```

### Smoke Tests

```bash
# Health check
curl https://api.hope.com/api/v1/health

# Test API endpoint
curl -H "X-API-Key: your-key" https://api.hope.com/api/v1/sessions
```

### Performance Testing

```bash
# Install Apache Bench
sudo apt install apache2-utils

# Load test
ab -n 1000 -c 10 https://api.hope.com/api/v1/health
```

---

## Monitoring & Maintenance

### Health Checks

```bash
# Basic health
curl https://api.hope.com/api/v1/health

# Detailed health
curl https://api.hope.com/api/v1/health/ready
```

### Logging

```bash
# Docker logs
docker logs -f api-gateway

# Systemd logs
sudo journalctl -u hope-api -f

# Kubernetes logs
kubectl logs -f deployment/api-gateway -n hope
```

### Metrics

Access Prometheus metrics:
```bash
curl https://api.hope.com/metrics
```

### Backup & Recovery

```bash
# Database backup
pg_dump -U hope -h localhost hope > backup_$(date +%Y%m%d).sql

# Redis backup
redis-cli --rdb /backup/redis_$(date +%Y%m%d).rdb

# Application logs
tar -czf logs_$(date +%Y%m%d).tar.gz /var/log/hope
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker logs api-gateway

# Inspect container
docker inspect api-gateway

# Verify network
docker network inspect hope-network
```

### Database Connection Fails

```bash
# Test connection
psql -h postgres -U hope -d hope

# Check environment variables
docker exec api-gateway env | grep DB_

# Verify network connectivity
docker exec api-gateway ping postgres
```

### High Memory Usage

```bash
# Check memory
docker stats api-gateway

# Adjust Node.js memory
NODE_OPTIONS="--max-old-space-size=4096"
```

---

## Security Hardening

### SSL/TLS Configuration

- Use Let's Encrypt for free SSL certificates
- Enable TLS 1.2+ only
- Configure strong cipher suites
- Implement HSTS headers

### Network Security

- Use VPC/Private networks
- Configure security groups/firewall rules
- Implement network policies (Kubernetes)
- Enable DDoS protection

### Application Security

- Rotate secrets regularly
- Enable audit logging
- Implement rate limiting
- Use security scanning tools

### Compliance

- Enable HIPAA-compliant logging
- Implement data encryption at rest
- Configure audit trails
- Document access controls

---

## Graceful Shutdown

The API Gateway implements best-practice graceful shutdown handling for Kubernetes and Docker environments.

### Shutdown Sequence

When the application receives a termination signal (SIGTERM/SIGINT):

1. **Mark as Not Ready** - The `/health/ready` endpoint returns 503, signaling the load balancer to stop routing new traffic
2. **Drain Delay** - Wait for the configured drain delay (default: 5s) to allow in-flight requests to complete
3. **Close WebSocket Connections** - Notify connected clients of shutdown and close connections gracefully
4. **Resource Cleanup** - Close database connections, Redis connections, Kafka consumers, etc.
5. **Exit** - Application exits with success status code

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SHUTDOWN_TIMEOUT_MS` | 30000 | Total time allowed for graceful shutdown (match Kubernetes `terminationGracePeriodSeconds`) |
| `SHUTDOWN_DRAIN_DELAY_MS` | 5000 | Time to wait for load balancer to stop routing traffic |

### Kubernetes Configuration

Ensure your Kubernetes deployment has matching timeout values:

```yaml
spec:
  terminationGracePeriodSeconds: 30  # Should match SHUTDOWN_TIMEOUT_MS
  containers:
  - name: api
    env:
    - name: SHUTDOWN_TIMEOUT_MS
      value: "30000"
    - name: SHUTDOWN_DRAIN_DELAY_MS
      value: "5000"
    readinessProbe:
      httpGet:
        path: /api/v1/health/ready
        port: 8868
    initialDelaySeconds: 10
    periodSeconds: 5
    timeoutSeconds: 3
    failureThreshold: 3
    livenessProbe:
      httpGet:
        path: /api/v1/health/live
        port: 8868
      initialDelaySeconds: 30
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
```

### Health Endpoints

| Endpoint | Purpose | Returns 503 During Shutdown |
|----------|---------|----------------------------|
| `/api/v1/health/live` | Liveness probe - is the process running? | No |
| `/api/v1/health/ready` | Readiness probe - accept new traffic? | Yes |
| `/api/v1/health/startup` | Startup probe - has initialization completed? | No (after startup) |
| `/api/v1/health` | Detailed health information | No (returns shutdown status in body) |

### Testing Graceful Shutdown

```bash
# Start the API in a terminal
pnpm --filter @arcaai/api dev

# In another terminal, send SIGTERM
kill -SIGTERM <pid>

# Or using Docker
docker stop --time=30 api-gateway

# Or using Kubernetes
kubectl delete pod api-gateway-xxx -n hope
```

Watch the logs for the shutdown sequence:

```
INFO [Bootstrap] Graceful shutdown enabled with timeout: 30000ms, drain delay: 5000ms
INFO [GracefulShutdownService] Shutdown signal received - stopping acceptance of new requests
INFO [GracefulShutdownService] Waiting 5000ms for load balancer to drain traffic
INFO [SttGateway] STT Gateway shutting down, closing 2 connections
INFO [GracefulShutdownService] Application shutdown complete
```

---

## Additional Resources

- [Single Deployment Guide](../../../infrastructure/single-deployment/README.md)
- [Kubernetes Best Practices](../../../infrastructure/archived/KUBERNETES_BEST_PRACTICES_IMPLEMENTATION.md)
- [Security Guide](../../../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md)
- [Production Checklist](../../../infrastructure/archived/PRODUCTION_DEPLOYMENT_CHECKLIST.md)

---

**Document Version**: 2.0
**Last Updated**: 2026-02-22
**Maintained By**: HOPE DevOps Team

