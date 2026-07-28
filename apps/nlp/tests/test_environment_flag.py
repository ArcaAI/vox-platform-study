"""Regression tests for the ENVIRONMENT / NLP_ENVIRONMENT flag duplication.

Prior to this fix, ``is_production()`` read the bare ``ENVIRONMENT`` env var
while ``NLPServiceConfig.environment`` (used by observability) read the typed
``NLP_ENVIRONMENT`` var. An operator who set only ``NLP_ENVIRONMENT=production``
(per docs/05-configuration.md) would not get ``/docs``/``/redoc`` disabled.
See docs/implementation/TASK-582-Python-Service-Env-Template-Hygiene/README.md
for how this was found.
"""

import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from nlp.core.config import Environment, NLPServiceConfig
from nlp.utils import is_production


def _service_config_from_env(**env):
    """Build a real NLPServiceConfig with ENVIRONMENT/NLP_ENVIRONMENT set
    explicitly, leaving the rest of the process env untouched."""
    overrides = {"ENVIRONMENT": None, "NLP_ENVIRONMENT": None, **env}
    with patch.dict(os.environ, {}, clear=False):
        for key, value in overrides.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return NLPServiceConfig()


class TestIsProductionUsesTypedEnvironmentSetting:
    def test_true_when_only_nlp_environment_production(self):
        cfg = _service_config_from_env(NLP_ENVIRONMENT="production")
        with patch("nlp.core.config.settings.service", cfg):
            assert is_production() is True

    def test_false_when_only_nlp_environment_development(self):
        cfg = _service_config_from_env(NLP_ENVIRONMENT="development")
        with patch("nlp.core.config.settings.service", cfg):
            assert is_production() is False

    def test_bare_environment_var_no_longer_has_any_effect(self):
        """The legacy bare ENVIRONMENT var must be fully retired."""
        cfg = _service_config_from_env(ENVIRONMENT="production")
        with patch("nlp.core.config.settings.service", cfg):
            assert is_production() is False

    def test_matches_typed_environment_field_directly(self):
        cfg = _service_config_from_env(NLP_ENVIRONMENT="production")
        assert cfg.environment == Environment.PRODUCTION
        with patch("nlp.core.config.settings.service", cfg):
            assert is_production() is True


class TestDocsExposureFollowsNlpEnvironment:
    def test_docs_disabled_with_only_nlp_environment_production(self, mock_services):
        cfg = _service_config_from_env(NLP_ENVIRONMENT="production")
        with patch("nlp.core.config.settings.service", cfg):
            from nlp.app import get_app

            app = get_app()
            with TestClient(app) as c:
                assert c.get("/docs").status_code == 404
                assert c.get("/redoc").status_code == 404

    def test_docs_enabled_with_only_nlp_environment_development(self, mock_services):
        cfg = _service_config_from_env(NLP_ENVIRONMENT="development")
        with patch("nlp.core.config.settings.service", cfg):
            from nlp.app import get_app

            app = get_app()
            with TestClient(app) as c:
                assert c.get("/docs").status_code == 200
                assert c.get("/redoc").status_code == 200
