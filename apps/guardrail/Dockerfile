# Use Python 3.11 slim image
FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/app/src" \
    GUARDRAIL_HOST=0.0.0.0 \
    GUARDRAIL_PORT=8863

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy requirements first for better caching
COPY pyproject.toml ./

# Install Python dependencies
RUN pip install --no-cache-dir -e .

# Copy application code
COPY src/ ./src/
COPY .env.example .env

# Create non-root user
RUN useradd --create-home --shell /bin/bash guardrail && \
    chown -R guardrail:guardrail /app
USER guardrail

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8863/api/v1/health/live || exit 1

# Expose port
EXPOSE 8863

# Run the application
CMD ["python", "-m", "guardrail.main"]
