"""TASK-890 §3.7a — the Azure deployment-vs-model precedence, pinned on BOTH sides.

Azure OpenAI routes by DEPLOYMENT name, not model name, so
``AzureOpenAIProvider._resolve_model`` prefers a resolved override's
``deployment_name`` over the caller-supplied ``request.model``. That rule is
correct and stays; it is also exactly why a tenant with several deployments
could not reach more than one of them — the connection carries a single
``deploymentName``, and it won every time.

The gateway half of the fix lives in ``text-generation-spec.ts``: a candidate
built from a TENANT-DECLARED model (an ``AiModel`` row carrying
``sourceConnectionId``) omits ``deployment_name`` from its override entry,
because the ROW is the deployment. This file pins the consequence on the
serving side, both branches, so neither half can drift without a red test:

  * override WITH ``deployment_name`` (the SYSTEM/platform connection, and any
    single-deployment tenant connection) → that deployment is used;
  * override WITHOUT it (a tenant-declared model) → ``request.model`` is used,
    which is the agent's bound model.
"""

from __future__ import annotations

from pydantic import SecretStr

from text.models.requests import GenerateRequest, ProviderOverride


def _request(model: str, *, deployment_name: str | None) -> GenerateRequest:
    override = ProviderOverride(
        api_key=SecretStr("k"),
        base_url="https://acme.openai.azure.com",
        api_version="2024-10-21",
        deployment_name=deployment_name,
    )
    return GenerateRequest(
        prompt="hi",
        provider="azure_openai",
        model=model,
        provider_overrides={"azure_openai": override},
    )


class TestAzureDeploymentPrecedence:
    def test_a_configured_deployment_still_wins_over_the_request_model(self):
        """The platform connection names ONE deployment; that is what it serves."""
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        request = _request("gpt-5.4-mini", deployment_name="platform-gpt-5-4-mini")

        assert provider._resolve_model(request) == "platform-gpt-5-4-mini"

    def test_without_a_deployment_the_requested_model_reaches_azure(self):
        """A tenant-declared model: the gateway omits `deployment_name`, so the
        agent's bound model — which IS the tenant's deployment name — is used."""
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        request = _request("tenant-gpt-4o-mini", deployment_name=None)

        assert provider._resolve_model(request) == "tenant-gpt-4o-mini"

    def test_an_empty_deployment_string_is_not_a_deployment(self):
        """`""` is the "no opinion" shape the connection row stores; it must not
        blank the model out and 400 at Azure."""
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        request = _request("tenant-gpt-4o-mini", deployment_name="")

        assert provider._resolve_model(request) == "tenant-gpt-4o-mini"

    def test_no_override_at_all_forwards_the_request_model(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()
        request = GenerateRequest(prompt="hi", provider="azure_openai", model="gpt-4o-mini")

        assert provider._resolve_model(request) == "gpt-4o-mini"
