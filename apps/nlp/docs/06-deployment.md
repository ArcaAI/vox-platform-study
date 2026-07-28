# Deployment Guide

Complete guide for deploying the HOPE NLP Service to production.

## Production Checklist

- [ ] Configure environment variables
- [ ] Set up GPU (if available)
- [ ] Configure logging
- [ ] Set up monitoring
- [ ] Enable security features
- [ ] Test health checks
- [ ] Configure backup and recovery
- [ ] Set up alerting
- [ ] Document deployment

## Docker Deployment

### Build Production Image

```bash
# Build production image
docker build --target production -t hope-nlp:1.0.0 .

# Tag for registry
docker tag hope-nlp:1.0.0 registry.example.com/hope-nlp:1.0.0

# Push to registry
docker push registry.example.com/hope-nlp:1.0.0
```

### Run Production Container

```bash
docker run -d \
  --name hope-nlp-prod \
  -p 8864:8864 \
  -e NLP_ENVIRONMENT=production \
  -e TEXT_CLASSIFIER_USE_GPU=true \
  -e TOKEN_CLASSIFIER_USE_GPU=true \
  --env-file .env.prod \
  --gpus all \
  --restart unless-stopped \
  --memory="4g" \
  --cpus="2.0" \
  hope-nlp:1.0.0
```

## Docker Compose Deployment

```yaml
version: '3.8'

services:
  nlp:
    image: hope-nlp:1.0.0
    container_name: hope-nlp-prod
    ports:
      - "8864:8864"
    environment:
      - NLP_ENVIRONMENT=production
      - TEXT_CLASSIFIER_USE_GPU=true
      - TOKEN_CLASSIFIER_USE_GPU=true
    env_file:
      - .env.prod
    volumes:
      - huggingface-cache:/root/.cache/huggingface
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8864/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

volumes:
  huggingface-cache:
```

## Kubernetes Deployment

### Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hope-nlp
  namespace: hope
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hope-nlp
  template:
    metadata:
      labels:
        app: hope-nlp
    spec:
      containers:
      - name: nlp
        image: hope-nlp:1.0.0
        ports:
        - containerPort: 8864
        env:
        - name: NLP_ENVIRONMENT
          value: "production"
        - name: TEXT_CLASSIFIER_USE_GPU
          value: "true"
        envFrom:
        - secretRef:
            name: nlp-secrets
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
            nvidia.com/gpu: 1
          limits:
            memory: "4Gi"
            cpu: "2000m"
            nvidia.com/gpu: 1
        livenessProbe:
          httpGet:
            path: /api/v1/health
            port: 8864
          initialDelaySeconds: 60
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /api/v1/health
            port: 8864
          initialDelaySeconds: 30
          periodSeconds: 10
```

### Service Manifest

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hope-nlp
  namespace: hope
spec:
  selector:
    app: hope-nlp
  ports:
  - port: 8864
    targetPort: 8864
  type: ClusterIP
```

## Single-Server Deployment

### Using Systemd

Create `/etc/systemd/system/hope-nlp.service`:

```ini
[Unit]
Description=HOPE NLP Service
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=hope
WorkingDirectory=/opt/hope/nlp
EnvironmentFile=/opt/hope/nlp/.env.prod
ExecStartPre=-/usr/bin/docker stop hope-nlp
ExecStartPre=-/usr/bin/docker rm hope-nlp
ExecStart=/usr/bin/docker run --name hope-nlp \
  -p 8864:8864 \
  --env-file /opt/hope/nlp/.env.prod \
  --gpus all \
  hope-nlp:1.0.0
ExecStop=/usr/bin/docker stop hope-nlp
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable hope-nlp
sudo systemctl start hope-nlp
sudo systemctl status hope-nlp
```

## Environment-Specific Configuration

### Production Environment Variables

```bash
# Service
NLP_ENVIRONMENT=production
NLP_DEBUG=false
NLP_LOG_LEVEL=INFO

# Performance
TEXT_CLASSIFIER_USE_GPU=true
TOKEN_CLASSIFIER_USE_GPU=true
MEDICAL_SUGGESTER_USE_GPU=true
TEXT_CLASSIFIER_FP16=true
TOKEN_CLASSIFIER_FP16=true

# Security
SECURITY_CORS_ORIGINS='["https://app.hope.example.com"]'

# Observability
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

## Monitoring Setup

### Prometheus Configuration

```yaml
scrape_configs:
  - job_name: 'hope-nlp'
    static_configs:
      - targets: ['nlp:8864']
    metrics_path: '/metrics'
```

### Grafana Dashboard

Import the NLP service dashboard (ID: coming soon) or create custom dashboards monitoring:
- Request rate and latency
- Model inference time
- Error rates
- Resource usage (CPU, memory, GPU)

## Health Checks

### Liveness Probe

```bash
curl http://localhost:8864/api/v1/health
```

Expected: `200 OK` with JSON response

### Readiness Probe

Check if models are loaded:
```bash
curl http://localhost:8864/api/v1/health
```

Should return model status in response.

## Scaling

### Horizontal Scaling

```bash
# Docker Compose scale
docker-compose up -d --scale nlp=3

# Kubernetes scale
kubectl scale deployment hope-nlp --replicas=3
```

### Vertical Scaling

Adjust resource limits:
```yaml
resources:
  requests:
    memory: "4Gi"
    cpu: "2000m"
  limits:
    memory: "8Gi"
    cpu: "4000m"
```

## Backup and Recovery

### Model Cache Backup

```bash
# Backup Hugging Face cache
tar -czf huggingface-cache-backup.tar.gz ~/.cache/huggingface/

# Restore
tar -xzf huggingface-cache-backup.tar.gz -C ~/
```

### Configuration Backup

```bash
# Backup configuration
cp .env.prod .env.prod.backup

# Backup dictionaries
tar -czf dictionaries-backup.tar.gz data/dictionaries/
```

## Troubleshooting Production Issues

### Service Won't Start

```bash
# Check logs
docker logs hope-nlp

# Check GPU availability
nvidia-smi

# Verify configuration
docker exec hope-nlp env | grep NLP_
```

### High Memory Usage

```bash
# Check memory
docker stats hope-nlp

# Reduce batch size
TEXT_CLASSIFIER_BATCH_SIZE=8
TOKEN_CLASSIFIER_BATCH_SIZE=8

# Restart with limits
docker run --memory="2g" ...
```

### Slow Performance

```bash
# Enable GPU
TEXT_CLASSIFIER_USE_GPU=true

# Enable FP16
TEXT_CLASSIFIER_FP16=true

# Check GPU utilization
nvidia-smi
```

## Security Hardening

1. **Run as non-root user** (already implemented)
2. **Use distroless images** (already implemented)
3. **Enable HTTPS** at reverse proxy
4. **Restrict CORS origins**
5. **Enable rate limiting**
6. **Use secrets management**
7. **Regular security scans**
8. **Keep dependencies updated**

## Production Maintenance

### Regular Tasks

- Monitor logs and metrics
- Check disk space
- Update dependencies
- Review security advisories
- Test backups
- Verify health checks
- Performance tuning

### Deployment Updates

```bash
# Pull new image
docker pull hope-nlp:1.1.0

# Stop old container
docker stop hope-nlp

# Start new container
docker run -d --name hope-nlp hope-nlp:1.1.0

# Verify health
curl http://localhost:8864/api/v1/health
```

## Support

For production support:
- Check logs first
- Review monitoring dashboards
- Consult troubleshooting guide
- Contact DevOps team

