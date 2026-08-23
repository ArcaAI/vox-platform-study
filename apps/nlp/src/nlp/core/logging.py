import json
import logging
import logging.handlers
import os
from datetime import UTC, datetime
from pathlib import Path


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
    """Centralized logging configuration for the NLP application."""

    # Default configuration values
    DEFAULT_LOG_LEVEL = "INFO"
    DEFAULT_LOG_PATH = "./logs"
    DEFAULT_MAX_SIZE = "10m"  # 10 megabytes
    DEFAULT_MAX_FILES = 1000
    DEFAULT_CONSOLE_ENABLED = True
    DEFAULT_ROTATION_WHEN = "midnight"  # Daily rotation at midnight
    DEFAULT_ROTATION_INTERVAL = 1  # Every 1 day
    DEFAULT_ROTATION_BACKUP_COUNT = 30  # Keep 30 days of logs

    # Log format templates
    DETAILED_FORMAT = (
        "[%(asctime)s] %(levelname)s - %(name)s :: %(funcName)s:%(lineno)d :: %(message)s"
    )
    SIMPLE_FORMAT = "[%(asctime)s] %(levelname)s - %(name)s :: %(message)s"

    @classmethod
    def _parse_size(cls, size_str: str) -> int:
        """Parse size string like '10m', '500k', '1g' to bytes."""
        size_str = size_str.lower().strip()
        if size_str.endswith("k"):
            return int(size_str[:-1]) * 1024
        elif size_str.endswith("m"):
            return int(size_str[:-1]) * 1024 * 1024
        elif size_str.endswith("g"):
            return int(size_str[:-1]) * 1024 * 1024 * 1024
        else:
            return int(size_str)

    @classmethod
    def _ensure_log_directory(cls, log_path: str) -> Path:
        """Ensure log directory exists and return Path object."""
        path = Path(log_path)
        path.mkdir(parents=True, exist_ok=True)
        return path

    @classmethod
    def _get_env_bool(cls, env_var: str, default: bool = False) -> bool:
        """Get boolean value from environment variable."""
        value = os.getenv(env_var, "").lower()
        return value in ("true", "1", "yes", "on") if value else default

    @classmethod
    def setup_logging(cls, service_name: str = "nlp") -> logging.Logger:
        """
        Setup comprehensive logging configuration.

        Args:
            service_name: Name of the service for log files

        Returns:
            Logger instance for the main application
        """
        # Get configuration from environment variables.
        #
        # `NLP_LOG_LEVEL` is the name `NLPServiceConfig.log_level` declares
        # (core/config.py) and the name `apps/nlp/.env.sample` documents; this
        # module read only the bare `LOG_LEVEL`, so ONE service had two names
        # for one concept and the documented one did nothing. Since every
        # deployable now shares a single `.env.<NODE_ENV>`, the bare name is
        # also whatever the gateway last set. Prefixed first, bare as the
        # fallback (TASK-799 B.3).
        # `NLPServiceConfig.log_level` is typed `int`, so the same variable is
        # legitimately written as `20` or as `INFO`. Both resolve here, exactly
        # as they now do in the settings class.
        raw_level = (os.getenv("NLP_LOG_LEVEL") or os.getenv("LOG_LEVEL") or cls.DEFAULT_LOG_LEVEL).strip()
        log_level = logging.getLevelName(int(raw_level)) if raw_level.isdigit() else raw_level.upper()
        log_file_enabled = cls._get_env_bool("LOG_FILE_ENABLED", False)
        log_file_path = os.getenv("LOG_FILE_PATH", cls.DEFAULT_LOG_PATH)
        log_file_max_size = os.getenv("LOG_FILE_MAX_SIZE", cls.DEFAULT_MAX_SIZE)
        log_file_max_files = int(os.getenv("LOG_FILE_MAX_FILES", cls.DEFAULT_MAX_FILES))
        log_file_separate_error = cls._get_env_bool("LOG_FILE_SEPARATE_ERROR", False)
        console_enabled = cls._get_env_bool("LOG_CONSOLE_ENABLED", cls.DEFAULT_CONSOLE_ENABLED)
        # New option to enable/disable JSON formatting for file logs
        json_format_enabled = cls._get_env_bool("LOG_FILE_JSON_FORMAT", True)

        # Daily rotation configuration
        rotation_when = os.getenv("LOG_ROTATION_WHEN", cls.DEFAULT_ROTATION_WHEN)
        rotation_interval = int(os.getenv("LOG_ROTATION_INTERVAL", cls.DEFAULT_ROTATION_INTERVAL))
        rotation_backup_count = int(
            os.getenv("LOG_ROTATION_BACKUP_COUNT", cls.DEFAULT_ROTATION_BACKUP_COUNT)
        )
        use_daily_rotation = cls._get_env_bool("LOG_USE_DAILY_ROTATION", True)

        # Clear any existing handlers to avoid duplication
        root_logger = logging.getLogger()
        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)

        # Set root logger level
        root_logger.setLevel(getattr(logging, log_level, logging.INFO))

        # Create formatters
        detailed_formatter = logging.Formatter(cls.DETAILED_FORMAT)
        simple_formatter = logging.Formatter(cls.SIMPLE_FORMAT)
        json_formatter = JsonFormatter()

        handlers: list[logging.Handler] = []

        console_json_format = cls._get_env_bool("LOG_CONSOLE_JSON_FORMAT", False)

        if console_enabled:
            console_handler = logging.StreamHandler()
            console_handler.setLevel(getattr(logging, log_level, logging.INFO))
            console_handler.setFormatter(
                json_formatter if console_json_format else simple_formatter
            )
            handlers.append(console_handler)

        # File handlers
        if log_file_enabled:
            log_dir = cls._ensure_log_directory(log_file_path)
            max_bytes = cls._parse_size(log_file_max_size)

            # Choose formatter for file logs
            file_formatter = json_formatter if json_format_enabled else detailed_formatter

            # Main log file (all levels)
            main_log_file = log_dir / f"{service_name}.log"

            main_file_handler: (
                logging.handlers.TimedRotatingFileHandler | logging.handlers.RotatingFileHandler
            )
            if use_daily_rotation:
                main_file_handler = logging.handlers.TimedRotatingFileHandler(
                    filename=str(main_log_file),
                    when=rotation_when,
                    interval=rotation_interval,
                    backupCount=rotation_backup_count,
                    encoding="utf-8",
                    utc=True,
                )
            else:
                main_file_handler = logging.handlers.RotatingFileHandler(
                    filename=str(main_log_file),
                    maxBytes=max_bytes,
                    backupCount=log_file_max_files,
                    encoding="utf-8",
                )

            main_file_handler.setLevel(getattr(logging, log_level, logging.INFO))
            main_file_handler.setFormatter(file_formatter)
            handlers.append(main_file_handler)

            # Separate error log file
            if log_file_separate_error:
                error_log_file = log_dir / f"{service_name}_errors.log"

                error_file_handler: (
                    logging.handlers.TimedRotatingFileHandler | logging.handlers.RotatingFileHandler
                )
                if use_daily_rotation:
                    error_file_handler = logging.handlers.TimedRotatingFileHandler(
                        filename=str(error_log_file),
                        when=rotation_when,
                        interval=rotation_interval,
                        backupCount=rotation_backup_count,
                        encoding="utf-8",
                        utc=True,
                    )
                else:
                    error_file_handler = logging.handlers.RotatingFileHandler(
                        filename=str(error_log_file),
                        maxBytes=max_bytes,
                        backupCount=log_file_max_files,
                        encoding="utf-8",
                    )

                error_file_handler.setLevel(logging.ERROR)
                error_file_handler.setFormatter(file_formatter)
                handlers.append(error_file_handler)

        # Add all handlers to root logger
        for handler in handlers:
            root_logger.addHandler(handler)

        # Get main application logger
        app_logger = logging.getLogger(service_name)

        # Log configuration summary
        config_summary = [
            f"Logging configured for service: {service_name}",
            f"Log level: {log_level}",
            f"Console logging: {'enabled' if console_enabled else 'disabled'}",
            f"File logging: {'enabled' if log_file_enabled else 'disabled'}",
        ]

        if log_file_enabled:
            config_summary.extend(
                [
                    f"Log directory: {log_file_path}",
                    f"Daily rotation: {'enabled' if use_daily_rotation else 'disabled'}",
                ]
            )

            if use_daily_rotation:
                config_summary.extend(
                    [
                        f"Rotation: {rotation_when} every {rotation_interval} day(s)",
                        f"Backup count: {rotation_backup_count} files",
                    ]
                )
            else:
                config_summary.extend(
                    [
                        f"Max file size: {log_file_max_size}",
                        f"Max files: {log_file_max_files}",
                    ]
                )

            config_summary.extend(
                [
                    f"Separate error log: {'enabled' if log_file_separate_error else 'disabled'}",
                    f"JSON format: {'enabled' if json_format_enabled else 'disabled'}",
                ]
            )

        app_logger.info(" | ".join(config_summary))

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
