#!/bin/bash
# =============================================================================
# STT-v2 Build Validation Script
# Validates Docker build and basic functionality
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="${IMAGE_NAME:-stt-v2}"
IMAGE_TAG="${IMAGE_TAG:-test}"
CONTAINER_NAME="stt-v2-validate"
HEALTH_CHECK_TIMEOUT=60
HEALTH_CHECK_INTERVAL=2

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}STT-v2 Build Validation${NC}"
echo -e "${YELLOW}========================================${NC}"

# Function to cleanup
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    docker stop $CONTAINER_NAME 2>/dev/null || true
    docker rm $CONTAINER_NAME 2>/dev/null || true
}

# Set trap for cleanup
trap cleanup EXIT

# Step 1: Build the image
echo -e "\n${YELLOW}Step 1: Building Docker image (runtime target)...${NC}"
docker build \
    --target runtime \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    -f docker/Dockerfile \
    .

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Build successful${NC}"
else
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi

# Step 2: Check image size
echo -e "\n${YELLOW}Step 2: Checking image size...${NC}"
IMAGE_SIZE=$(docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}")
echo "Image size: $IMAGE_SIZE"

# Step 3: Run security scan (if trivy is available)
if command -v trivy &> /dev/null; then
    echo -e "\n${YELLOW}Step 3: Running security scan...${NC}"
    trivy image --severity HIGH,CRITICAL "${IMAGE_NAME}:${IMAGE_TAG}" || true
else
    echo -e "\n${YELLOW}Step 3: Skipping security scan (trivy not installed)${NC}"
fi

# Step 4: Start container
echo -e "\n${YELLOW}Step 4: Starting container...${NC}"
docker run -d \
    --name $CONTAINER_NAME \
    -p 8001:8001 \
    -e DATABASE_URL="postgresql+asyncpg://postgres:postgres@host.docker.internal:5432/hope" \
    -e REDIS_URL="redis://host.docker.internal:6379/0" \
    -e DEBUG="true" \
    "${IMAGE_NAME}:${IMAGE_TAG}"

# Step 5: Wait for health check
echo -e "\n${YELLOW}Step 5: Waiting for health check...${NC}"
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $HEALTH_CHECK_TIMEOUT ]; do
    # Check container is still running
    if ! docker ps | grep -q $CONTAINER_NAME; then
        echo -e "${RED}Container stopped unexpectedly${NC}"
        docker logs $CONTAINER_NAME
        exit 1
    fi

    # Check health endpoint
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/health 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
        HEALTHY=true
        break
    fi

    echo "Waiting... ($ELAPSED/${HEALTH_CHECK_TIMEOUT}s)"
    sleep $HEALTH_CHECK_INTERVAL
    ELAPSED=$((ELAPSED + HEALTH_CHECK_INTERVAL))
done

if [ "$HEALTHY" = true ]; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    docker logs $CONTAINER_NAME
    exit 1
fi

# Step 6: Validate endpoints
echo -e "\n${YELLOW}Step 6: Validating endpoints...${NC}"

# Health endpoint
echo "Testing /health..."
RESPONSE=$(curl -s http://localhost:8001/health)
if echo "$RESPONSE" | grep -q '"status"'; then
    echo -e "${GREEN}✓ /health OK${NC}"
else
    echo -e "${RED}✗ /health failed${NC}"
    exit 1
fi

# Ready endpoint
echo "Testing /ready..."
RESPONSE=$(curl -s http://localhost:8001/ready)
if echo "$RESPONSE" | grep -q '"status"'; then
    echo -e "${GREEN}✓ /ready OK${NC}"
else
    echo -e "${YELLOW}⚠ /ready returned non-standard response (expected with missing deps)${NC}"
fi

# Live endpoint
echo "Testing /live..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/live)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ /live OK${NC}"
else
    echo -e "${RED}✗ /live failed${NC}"
    exit 1
fi

# Metrics endpoint
echo "Testing /metrics..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/metrics)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ /metrics OK${NC}"
else
    echo -e "${YELLOW}⚠ /metrics not available${NC}"
fi

# Step 7: Check container logs for errors
echo -e "\n${YELLOW}Step 7: Checking logs for errors...${NC}"
if docker logs $CONTAINER_NAME 2>&1 | grep -iE "error|exception|traceback" | grep -v "INFO"; then
    echo -e "${YELLOW}⚠ Found potential errors in logs${NC}"
else
    echo -e "${GREEN}✓ No errors in logs${NC}"
fi

# Summary
echo -e "\n${YELLOW}========================================${NC}"
echo -e "${GREEN}✓ Build validation passed!${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "Size: $IMAGE_SIZE"
echo ""
echo "To push to registry:"
echo "  docker tag ${IMAGE_NAME}:${IMAGE_TAG} registry.example.com/${IMAGE_NAME}:${IMAGE_TAG}"
echo "  docker push registry.example.com/${IMAGE_NAME}:${IMAGE_TAG}"
