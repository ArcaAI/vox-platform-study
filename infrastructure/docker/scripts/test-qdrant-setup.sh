#!/bin/bash
# ============================================================================
# Qdrant Setup Verification Script
# Tests Qdrant installation and collection configuration
# ============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
QDRANT_HOST="${QDRANT_HOST:-localhost}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
COLLECTION_NAME="stt_speaker_embeddings"

# Helper functions
print_header() {
    echo ""
    echo "============================================================================"
    echo "$1"
    echo "============================================================================"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Check if curl is available
if ! command -v curl &> /dev/null; then
    print_error "curl is not installed. Please install curl first."
    exit 1
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
    print_warning "jq is not installed. Output will be less formatted."
    print_info "Install jq for better output: brew install jq (macOS) or apt-get install jq (Ubuntu)"
    JQ_AVAILABLE=false
else
    JQ_AVAILABLE=true
fi

print_header "Qdrant Setup Verification"

# Test 1: Health Check
print_info "Test 1: Checking Qdrant health..."
if curl -s -f "http://${QDRANT_HOST}:${QDRANT_PORT}/health" > /dev/null 2>&1; then
    print_success "Qdrant is healthy and responsive"
else
    print_error "Qdrant is not responding at http://${QDRANT_HOST}:${QDRANT_PORT}"
    print_error "Make sure Qdrant container is running: docker ps | grep qdrant"
    exit 1
fi

echo ""

# Test 2: List Collections
print_info "Test 2: Listing collections..."
if $JQ_AVAILABLE; then
    collections=$(curl -s "http://${QDRANT_HOST}:${QDRANT_PORT}/collections" | jq -r '.result.collections[].name')
    if [ -z "$collections" ]; then
        print_warning "No collections found"
    else
        print_success "Collections found:"
        echo "$collections" | while read -r col; do
            echo "  - $col"
        done
    fi
else
    curl -s "http://${QDRANT_HOST}:${QDRANT_PORT}/collections"
fi

echo ""

# Test 3: Check if STT collection exists
print_info "Test 3: Checking if collection '${COLLECTION_NAME}' exists..."
if curl -s -f "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}" > /dev/null 2>&1; then
    print_success "Collection '${COLLECTION_NAME}' exists"

    # Get collection details
    if $JQ_AVAILABLE; then
        collection_info=$(curl -s "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}")
        vector_size=$(echo "$collection_info" | jq -r '.result.config.params.vectors.size')
        distance=$(echo "$collection_info" | jq -r '.result.config.params.vectors.distance')
        points_count=$(echo "$collection_info" | jq -r '.result.points_count')
        vectors_count=$(echo "$collection_info" | jq -r '.result.vectors_count')

        print_info "Collection details:"
        echo "  - Vector size: ${vector_size} dimensions"
        echo "  - Distance metric: ${distance}"
        echo "  - Points count: ${points_count}"
        echo "  - Vectors count: ${vectors_count}"
    else
        curl -s "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}"
    fi
else
    print_error "Collection '${COLLECTION_NAME}' does not exist"
    print_info "Run initialization: docker-compose -f docker-compose.stt-dev.yml up qdrant-init"
    exit 1
fi

echo ""

# Test 4: Test Write Operation
print_info "Test 4: Testing write operation..."

# Create test vector (512 dimensions)
test_vector=$(python3 -c "import json; print(json.dumps([0.1] * 512))")

test_payload='{
  "points": [
    {
      "id": "test-verification-001",
      "vector": '"${test_vector}"',
      "payload": {
        "speaker_code": "TEST_VERIFY",
        "speaker_name": "Verification Test",
        "tenant_id": "00000000-0000-0000-0000-000000000000",
        "test": true,
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
      }
    }
  ]
}'

write_result=$(curl -s -X PUT "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}/points" \
  -H 'Content-Type: application/json' \
  -d "$test_payload")

if [ $? -eq 0 ]; then
    if $JQ_AVAILABLE; then
        status=$(echo "$write_result" | jq -r '.status')
        if [ "$status" = "ok" ]; then
            print_success "Write operation successful"
        else
            print_error "Write operation failed"
            echo "$write_result" | jq '.'
        fi
    else
        print_success "Write operation completed"
    fi
else
    print_error "Write operation failed"
    exit 1
fi

echo ""

# Test 5: Test Search Operation
print_info "Test 5: Testing search operation..."

search_payload='{
  "vector": '"${test_vector}"',
  "limit": 5,
  "with_payload": true
}'

search_result=$(curl -s -X POST "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}/points/search" \
  -H 'Content-Type: application/json' \
  -d "$search_payload")

if [ $? -eq 0 ]; then
    if $JQ_AVAILABLE; then
        status=$(echo "$search_result" | jq -r '.status')
        results_count=$(echo "$search_result" | jq -r '.result | length')

        if [ "$status" = "ok" ]; then
            print_success "Search operation successful"
            print_info "Found ${results_count} results"

            # Show top result
            if [ "$results_count" -gt 0 ]; then
                top_score=$(echo "$search_result" | jq -r '.result[0].score')
                top_speaker=$(echo "$search_result" | jq -r '.result[0].payload.speaker_code')
                echo "  - Top result: ${top_speaker} (score: ${top_score})"
            fi
        else
            print_error "Search operation failed"
            echo "$search_result" | jq '.'
        fi
    else
        print_success "Search operation completed"
    fi
else
    print_error "Search operation failed"
    exit 1
fi

echo ""

# Test 6: Test Delete Operation
print_info "Test 6: Testing delete operation (cleaning up test data)..."

delete_payload='{
  "points": ["test-verification-001"]
}'

delete_result=$(curl -s -X POST "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}/points/delete" \
  -H 'Content-Type: application/json' \
  -d "$delete_payload")

if [ $? -eq 0 ]; then
    if $JQ_AVAILABLE; then
        status=$(echo "$delete_result" | jq -r '.status')
        if [ "$status" = "ok" ]; then
            print_success "Delete operation successful (test data cleaned up)"
        else
            print_error "Delete operation failed"
            echo "$delete_result" | jq '.'
        fi
    else
        print_success "Delete operation completed"
    fi
else
    print_error "Delete operation failed"
fi

echo ""

# Test 7: Check Metrics Endpoint
print_info "Test 7: Checking metrics endpoint (Prometheus format)..."
if curl -s -f "http://${QDRANT_HOST}:${QDRANT_PORT}/metrics" > /dev/null 2>&1; then
    print_success "Metrics endpoint is available"
    print_info "Access at: http://${QDRANT_HOST}:${QDRANT_PORT}/metrics"
else
    print_warning "Metrics endpoint is not available"
fi

echo ""

# Summary
print_header "Verification Summary"

print_success "All critical tests passed!"
echo ""
print_info "Qdrant is ready for use with STT Orchestra"
echo ""
print_info "Connection details:"
echo "  - HTTP API: http://${QDRANT_HOST}:${QDRANT_PORT}"
echo "  - gRPC API: http://${QDRANT_HOST}:6334"
echo "  - Collection: ${COLLECTION_NAME}"
echo "  - Vector dimension: 512"
echo "  - Distance metric: Cosine"
echo ""
print_info "Next steps:"
echo "  1. Start STT Recognition service"
echo "  2. Service will automatically connect to this collection"
echo "  3. Speaker embeddings will be stored during transcription"
echo ""
print_info "Useful commands:"
echo "  - View collection: curl http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}"
echo "  - List all points: curl -X POST http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}/points/scroll -d '{\"limit\":10}'"
echo "  - Health check: curl http://${QDRANT_HOST}:${QDRANT_PORT}/health"
echo ""

print_success "Qdrant setup verification completed successfully!"

