import os
from datetime import datetime
from pathlib import Path

import dotenv

dotenv.load_dotenv()


def is_production() -> bool:
    return os.getenv("ENVIRONMENT") == "production"


def get_project_root() -> Path:
    return Path(__file__).parent.parent.parent


def get_current_time() -> datetime:
    return datetime.now()
