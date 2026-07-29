from datetime import datetime
from pathlib import Path

# NOTE: no env loading here. `nlp.core.config` imports this module, so a
# `load_dotenv()` at this scope ran BEFORE the canonical loader and — because
# dotenv does not overwrite — silently made the legacy `.env` outrank
# `.env.dev`. Env loading happens in exactly one place: `hope_env.load_env()`,
# called from `nlp.core.config`.


def is_production() -> bool:
    from nlp.core.config import Environment, settings

    return settings.service.environment == Environment.PRODUCTION


def get_project_root() -> Path:
    return Path(__file__).parent.parent.parent


def get_current_time() -> datetime:
    return datetime.now()
