#!/bin/bash
# ==============================================================================
# Generate Text Service Test & Coverage Deliverables Bundle
# ==============================================================================
# Produces:
#   ├── coverage_report.txt   (Plain text summary with missing lines)
#   ├── test_results.log      (Raw pytest execution console output)
#   ├── TEST_SUMMARY.md       (Formatted markdown test & coverage summary)
#   └── coverage_html/        (Interactive visual HTML report directory)
#       └── index.html
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== [1/4] Running pytest with pytest-cov ==="
# Determine Python runner (prefer active environment or system pytest)
if command -v pytest >/dev/null 2>&1; then
    PYTEST_CMD="pytest"
elif [ -f "/opt/miniconda3/bin/pytest" ]; then
    PYTEST_CMD="/opt/miniconda3/bin/pytest"
else
    PYTEST_CMD="python3 -m pytest"
fi

# Run pytest, stream output to console and write test_results.log
# Also generates coverage_html/index.html
$PYTEST_CMD src/text/tests/ \
    --cov=text \
    --cov-report=term-missing \
    --cov-report=html:coverage_html \
    -m "not e2e" \
    "$@" 2>&1 | tee test_results.log

echo "=== [2/4] Generating coverage_report.txt ==="
if command -v coverage >/dev/null 2>&1; then
    coverage report -m > coverage_report.txt
elif [ -f "/opt/miniconda3/bin/coverage" ]; then
    /opt/miniconda3/bin/coverage report -m > coverage_report.txt
else
    python3 -m coverage report -m > coverage_report.txt
fi

echo "=== [3/4] Generating TEST_SUMMARY.md ==="
# Extract key metrics from test_results.log and coverage_report.txt
TOTAL_TESTS_LINE=$(grep -E "==+ .* (passed|failed|skipped) .* in .* ==" test_results.log | tail -n 1 || echo "Tests completed")
TOTAL_COV_LINE=$(grep -E "^TOTAL\s+" coverage_report.txt | tail -n 1 || echo "TOTAL 0 0 0%")
COV_PCT=$(echo "$TOTAL_COV_LINE" | awk '{print $NF}')
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

cat <<EOF > TEST_SUMMARY.md
# Text Service Test & Coverage Summary

**Generated:** ${TIMESTAMP}  
**Target Package:** \`apps/text/src/text\`  
**Test Suite:** \`apps/text/src/text/tests\`  
**Overall Code Coverage:** **${COV_PCT}**

---

## 1. Test Execution Result
\`\`\`text
${TOTAL_TESTS_LINE}
\`\`\`

---

## 2. Coverage Overview

\`\`\`text
$(head -n 2 coverage_report.txt)
$(grep -E "^TOTAL\s+" coverage_report.txt)
\`\`\`

---

## 3. Deliverables Generated
- 📄 **Test Execution Log:** [\`test_results.log\`](test_results.log)
- 📝 **Plain-text Coverage Report:** [\`coverage_report.txt\`](coverage_report.txt)
- 🌐 **Interactive HTML Report:** [\`coverage_html/index.html\`](coverage_html/index.html)

EOF

echo "=== [4/4] Done! Generated all deliverables successfully: ==="
echo "  ├── coverage_report.txt"
echo "  ├── test_results.log"
echo "  ├── TEST_SUMMARY.md"
echo "  └── coverage_html/"
echo "      └── index.html"

