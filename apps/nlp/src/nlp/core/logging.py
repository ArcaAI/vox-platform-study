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


#: The declared default for every log SINK knob (TASK-799 lane D).
#:
#: These were twelve scattered `os.getenv` / `_get_env_bool` calls with their
#: defaults inlined at the call site, which is how the two sibling JSON switches
#: ended up with OPPOSITE defaults and no explanation: `LOG_FILE_JSON_FORMAT`
#: defaulted True, `LOG_CONSOLE_JSON_FORMAT` False, thirty lines apart.
#:
#: The split IS intentional — a file is machine-read (shipped to a log backend,
#: so JSON), a console is human-read during `pnpm nlp:dev` (so plain). Declaring
#: both here states that on purpose instead of leaving it to be inferred from two
#: distant literals.
#:
#: The serving values come from the control plane (`nlp.logging.*`, `global-kv`);
#: this table is the bootstrap floor. `LOG_LEVEL` and `LOG_FILE_PATH` stay in env
#: and are deliberately absent: the level is what an operator reaches for FIRST
#: during an incident (no control-plane round trip), and the path is a host fact
#: about where this container's writable volume is mounted.
LOG_SINK_DEFAULTS: dict[str, object] = {
    "file_enabled": False,
    "file_max_size": "10m",
    "file_max_files": 1000,
    "file_separate_error": False,
    "console_enabled": True,
    "file_json_format": True,
    "console_json_format": False,
    "rotation_when": "midnight",
    "rotation_interval": 1,
    "rotation_backup_count": 30,
    "use_daily_rotation": True,
}

#: Control-plane overlay, applied over `LOG_SINK_DEFAULTS` by `apply_log_sinks`.
_served_sinks: dict[str, object] = {}


def apply_log_sinks(served: dict[str, object]) -> None:
    """Adopt control-plane sink knobs. An absent key keeps the running value."""
    _served_sinks.update(served)


def log_sink(name: str) -> object:
    """The effective value for one sink knob: control plane over the floor."""
    return _served_sinks.get(name, LOG_SINK_DEFAULTS[name])


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
        raw_level = (
            os.getenv("NLP_LOG_LEVEL") or os.getenv("LOG_LEVEL") or cls.DEFAULT_LOG_LEVEL
        ).strip()
        log_level = (
            logging.getLevelName(int(raw_level)) if raw_level.isdigit() else raw_level.upper()
        )
        # Sink configuration: control plane over the declared bootstrap floor.
        # `LOG_FILE_PATH` stays a bare env read — it is a host fact about where
        # this container's writable volume is mounted, not platform policy.
        log_file_enabled = bool(log_sink("file_enabled"))
        log_file_path = os.getenv("LOG_FILE_PATH", cls.DEFAULT_LOG_PATH)
        log_file_max_size = str(log_sink("file_max_size"))
        log_file_max_files = int(log_sink("file_max_files"))  # type: ignore[call-overload]
        log_file_separate_error = bool(log_sink("file_separate_error"))
        console_enabled = bool(log_sink("console_enabled"))
        json_format_enabled = bool(log_sink("file_json_format"))

        # Daily rotation configuration
        rotation_when = str(log_sink("rotation_when"))
        rotation_interval = int(log_sink("rotation_interval"))  # type: ignore[call-overload]
        rotation_backup_count = int(log_sink("rotation_backup_count"))  # type: ignore[call-overload]
        use_daily_rotation = bool(log_sink("use_daily_rotation"))

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

        console_json_format = bool(log_sink("console_json_format"))

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
