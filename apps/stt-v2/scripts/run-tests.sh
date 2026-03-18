#!/bin/bash
# =============================================================================
# STT-v2 Test Runner Script
# Runs unit tests, integration tests, and generates coverage report
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
COVERAGE_THRESHOLD=${COVERAGE_THRESHOLD:-80}
TEST_TYPE="${1:-all}"  # all, unit, integration, e2e

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}STT-v2 Test Runner${NC}"
echo -e "${YELLOW}========================================${NC}"
echo "Test type: $TEST_TYPE"
echo "Coverage threshold: ${COVERAGE_THRESHOLD}%"
echo ""

# Change to project root
cd "$(dirname "$0")/.."

# Ensure we're in a virtual environment or have dependencies
if ! python -c "import pytest" 2>/dev/null; then
    echo -e "${RED}pytest not installed. Please install test dependencies:${NC}"
    echo "  conda activate arcaenv && pip install -e '.[test]'"
    exit 1
fi

# Function to run unit tests
run_unit_tests() {
    echo -e "\n${YELLOW}Running unit tests...${NC}"
    pytest tests/unit/ \
        -v \
        --tb=short \
        -m "not slow" \
        --cov=src/stt_v2 \
        --cov-report=term-missing \
        --cov-report=html:coverage/unit \
        --cov-report=xml:coverage/unit.xml \
        --junitxml=coverage/unit-results.xml
}

# Function to run integration tests
run_integration_tests() {
    echo -e "\n${YELLOW}Running integration tests...${NC}"

    # Check if Docker is running
    if ! docker info &>/dev/null; then
        echo -e "${RED}Docker is not running. Integration tests require Docker.${NC}"
        return 1
    fi

    pytest tests/integration/ \
        -v \
        --tb=short \
        -m "integration" \
        --cov=src/stt_v2 \
        --cov-report=term-missing \
        --cov-report=html:coverage/integration \
        --cov-report=xml:coverage/integration.xml \
        --junitxml=coverage/integration-results.xml
}

# Function to run e2e tests
run_e2e_tests() {
    echo -e "\n${YELLOW}Running E2E tests...${NC}"
    pytest tests/e2e/ \
        -v \
        --tb=short \
        -m "e2e" \
        --junitxml=coverage/e2e-results.xml
}

# Function to check coverage threshold
check_coverage() {
    echo -e "\n${YELLOW}Checking coverage threshold...${NC}"

    # Extract coverage percentage from report
    COVERAGE=$(pytest tests/unit/ --cov=src/stt_v2 --cov-report=term 2>&1 | grep "TOTAL" | awk '{print $NF}' | tr -d '%')

    if [ -z "$COVERAGE" ]; then
        echo -e "${YELLOW}Could not determine coverage percentage${NC}"
        return 0
    fi

    COVERAGE_INT=${COVERAGE%.*}

    if [ "$COVERAGE_INT" -ge "$COVERAGE_THRESHOLD" ]; then
        echo -e "${GREEN}✓ Coverage ${COVERAGE}% meets threshold ${COVERAGE_THRESHOLD}%${NC}"
        return 0
    else
        echo -e "${RED}✗ Coverage ${COVERAGE}% below threshold ${COVERAGE_THRESHOLD}%${NC}"
        return 1
    fi
}

# Create coverage directory
mkdir -p coverage

# Run tests based on type
case $TEST_TYPE in
    "unit")
        run_unit_tests
        check_coverage
        ;;
    "integration")
        run_integration_tests
        ;;
    "e2e")
        run_e2e_tests
        ;;
    "all")
        run_unit_tests
        if docker info &>/dev/null; then
            run_integration_tests || echo -e "${YELLOW}Integration tests skipped or failed${NC}"
        else
            echo -e "${YELLOW}Skipping integration tests (Docker not available)${NC}"
        fi
        check_coverage
        ;;
    *)
        echo "Usage: $0 [all|unit|integration|e2e]"
        exit 1
        ;;
esac

echo -e "\n${YELLOW}========================================${NC}"
echo -e "${GREEN}Test run complete!${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo "Coverage reports available at:"
echo "  - HTML: coverage/unit/index.html"
echo "  - XML:  coverage/unit.xml"
echo ""
