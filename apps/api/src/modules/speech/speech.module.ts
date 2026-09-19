import {
  AiProviderConnectionServiceModule,
  EntitlementsServiceModule,
  OriginRegistryServiceModule,
  TtsAgentResolverServiceModule,
  UsageLedgerServiceModule,
} from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { gatewayKeepAliveAgents } from '../../common';
import { HarnessTtsInternalController } from './harness-tts-internal.controller';
import { SpeechProxyController } from './speech-proxy.controller';
import { TtsWsGateway } from './tts-ws.gateway';

// IConfigService + SecretsService are provided app-wide by CommonServiceModule
// (under the app's @Global core), and StreamTicketService is @Global, so this
// module only needs the HTTP client, the TEXT_TO_SPEECH agent resolver, the
// unified provider-connection plane (BYO credential injection, `service='tts'`,
// ), the usage-ledger emission port, the
// entitlements quota port (monthlyTtsCharacters pre-flight
// neither is @Global, so every consuming module imports it explicitly), and
// to register the WS-duplex gateway.
@Module({
  imports: [
    // TASK-993 lane C — keepAlive pooling shared with `agent.module.ts` (both call
    // TTS_URL); see `common/gateway-http-agent.ts` for the sizing rationale.
    HttpModule.register({
      timeout: 120000,
      maxRedirects: 3,
      ...gatewayKeepAliveAgents,
    }),
    // TASK-879 — the ONE TEXT_TO_SPEECH resolution: the `AgentAssignment` cascade (or an explicit
    // `agentSlug`), the bound model with its mirror/artifacts/voices, the connection row that
    // serves each engine, and the funding-gated fallback chain. It replaced
    // `TenantTtsConfigServiceModule`, whose effective spec (routing chains, allowed providers,
    // voice bindings, format/speed/rate defaults) was the pre-agent shape of the same question.
    TtsAgentResolverServiceModule,
    AiProviderConnectionServiceModule,
    UsageLedgerServiceModule,
    EntitlementsServiceModule,
    // supplies `IOriginRegistry` to `TtsWsGateway`'s CSWSH
    // handshake check. Browsers do NOT apply CORS to WebSockets, so this is
    // the only place the allow-list reaches the socket path. The gateway
    // injects it `@Optional()` and fails CLOSED, so omitting this import does
    // not break the build — it refuses every browser origin instead.
    OriginRegistryServiceModule,
  ],
  // `HarnessTtsInternalController` is the `agentic.tts` node's synthesis dispatch
  // . It lives here rather than on the consultation module's harness
  // controller because every dependency it needs — the TTS config resolver, the
  // provider-connection plane, the usage ledger, the entitlements port — is already
  // imported above; see that controller's own docstring.
  controllers: [SpeechProxyController, HarnessTtsInternalController],
  providers: [TtsWsGateway],
})
export class SpeechModule {}
