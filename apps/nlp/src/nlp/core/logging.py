import json
import logging
import os
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    """Custom JSON formatter for structured logging with OTel trace correlation."""

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON with traceId/spanId from OTel LoggingInstrumentor."""
        log_data = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
            "thread": record.thread,
            "thread_name": record.threadName,
            "process": record.process,
        }

        trace_id = getattr(record, "otelTraceID", "0")
        span_id = getattr(record, "otelSpanID", "0")
        if trace_id and trace_id != "0":
            log_data["traceId"] = trace_id
            log_data["spanId"] = span_id
            log_data["traceFlags"] = getattr(record, "otelTraceFlags", "00")

        service_name = getattr(record, "otelServiceName", None)
        if service_name:
            log_data["service.name"] = service_name

        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        if hasattr(record, "extra_fields"):
            log_data.update(record.extra_fields)

        return json.dumps(log_data, ensure_ascii=False)


class LoggingConfig:
    """Centralized logging configuration for the NLP application.

    ONE sink: stdout. TASK-883 retired the file/rotation handlers and the eleven
    `nlp.logging.*` control-plane keys that steered them — the deployment ships
    stdout → Alloy → Loki and mounts no log volume for this service, so a
    rotating file wrote to an ephemeral container filesystem nobody read. No
    behaviour changed with it: `file_enabled` defaulted `false` and no seed ever
    wrote a row for any of those keys, so a file handler was never built.

    `LOG_LEVEL` stays an env read — it is what an operator reaches for FIRST
    during an incident, with no control-plane round trip.
    """

    DEFAULT_LOG_LEVEL = "INFO"

    # Log format template
    SIMPLE_FORMAT = "[%(asctime)s] %(levelname)s - %(name)s :: %(message)s"

    @classmethod
    def setup_logging(cls, service_name: str = "nlp") -> logging.Logger:
        """Install the single stdout handler and return the app logger.

        Args:
            service_name: Name of the service, used for the returned logger.

        Returns:
            Logger instance for the main application
        """
        # `NLP_LOG_LEVEL` is the name `NLPServiceConfig.log_level`
        # (core/config.py) and `apps/nlp/.env.sample` declare; the bare
        # `LOG_LEVEL` is whatever the shared env file last set. Prefixed first,
        # bare as the fallback. The field is typed `int`, so the same variable
        # is legitimately written as `20` or as `INFO` — both resolve here.
        raw_level = (
            os.getenv("NLP_LOG_LEVEL") or os.getenv("LOG_LEVEL") or cls.DEFAULT_LOG_LEVEL
        ).strip()
        log_level = (
            logging.getLevelName(int(raw_level)) if raw_level.isdigit() else raw_level.upper()
        )
        level = getattr(logging, log_level, logging.INFO)

        # Clear any existing handlers to avoid duplication
        root_logger = logging.getLogger()
        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)

        root_logger.setLevel(level)

        console_handler = logging.StreamHandler()
        console_handler.setLevel(level)
        console_handler.setFormatter(logging.Formatter(cls.SIMPLE_FORMAT))
        root_logger.addHandler(console_handler)

        app_logger = logging.getLogger(service_name)
        app_logger.info(
            "Logging configured for service: %s | Log level: %s | Sink: stdout",
            service_name,
            log_level,
        )

        return app_logger

    @classmethod
    def get_logger(cls, name: str) -> logging.Logger:
        """Get a logger instance with the specified name."""
        return logging.getLogger(name)


# Convenience function for easy import
def setup_logging(service_name: str = "nlp") -> logging.Logger:
    """Setup logging and return main application logger."""
    return LoggingConfig.setup_logging(service_name)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance with the specified name."""
    return LoggingConfig.get_logger(name)
