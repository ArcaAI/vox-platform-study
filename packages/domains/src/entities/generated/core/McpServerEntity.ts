/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// MCP external-tools registry row: one server per (tenant, name);
// the reserved SYSTEM tenant owns the shared registry rows. `authRef` is a
// Vault PATH ONLY (never secret material). `phiBoundary` records which side of
// the PHI boundary the server sits on (fail-safe default "external" ⇒ cloud
// egress). This entity carries only structural invariants; feature-flag gating
// (HarnessPolicy.mcpToolsEnabled) + allowlist intersection + PHI egress
// screening are enforced by the harness activity, and super-admin write
// authorization by the application service.
export type McpTransport = 'streamable-http';
export type McpPhiBoundary = 'external' | 'in-boundary';

export interface IMcpServerEntity extends IBaseTenantEntity {
  name: string;
  description?: string | null;
  baseUrl: string;
  transport: string;
  authRef?: string | null;
  toolAllowlist?: string[] | null;
  phiBoundary: string;
  enabled: boolean;
}

const ALLOWED_TRANSPORTS: ReadonlySet<string> = new Set(['streamable-http']);
const ALLOWED_PHI_BOUNDARIES: ReadonlySet<string> = new Set(['external', 'in-boundary']);

export class McpServerEntity extends BaseTenantEntity {
  private _name: IMcpServerEntity['name'];
  private _description?: IMcpServerEntity['description'];
  private _baseUrl: IMcpServerEntity['baseUrl'];
  private _transport: IMcpServerEntity['transport'];
  private _authRef?: IMcpServerEntity['authRef'];
  private _toolAllowlist?: IMcpServerEntity['toolAllowlist'];
  private _phiBoundary: IMcpServerEntity['phiBoundary'];
  private _enabled: IMcpServerEntity['enabled'];

  constructor(init: IMcpServerEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._baseUrl = init.baseUrl;
    this._transport = init.transport;
    this._authRef = init.authRef;
    this._toolAllowlist = init.toolAllowlist;
    this._phiBoundary = init.phiBoundary;
    this._enabled = init.enabled;
  }

  get name(): IMcpServerEntity['name'] {
    return this._name;
  }

  set name(value: IMcpServerEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IMcpServerEntity['description'] {
    return this._description;
  }

  set description(value: IMcpServerEntity['description']) {
    this.setProperty('description', value);
  }

  get baseUrl(): IMcpServerEntity['baseUrl'] {
    return this._baseUrl;
  }

  set baseUrl(value: IMcpServerEntity['baseUrl']) {
    this.setProperty('baseUrl', value);
  }

  get transport(): IMcpServerEntity['transport'] {
    return this._transport;
  }

  set transport(value: IMcpServerEntity['transport']) {
    this.setProperty('transport', value);
  }

  get authRef(): IMcpServerEntity['authRef'] {
    return this._authRef;
  }

  set authRef(value: IMcpServerEntity['authRef']) {
    this.setProperty('authRef', value);
  }

  get toolAllowlist(): IMcpServerEntity['toolAllowlist'] {
    return this._toolAllowlist;
  }

  set toolAllowlist(value: IMcpServerEntity['toolAllowlist']) {
    this.setProperty('toolAllowlist', value);
  }

  get phiBoundary(): IMcpServerEntity['phiBoundary'] {
    return this._phiBoundary;
  }

  set phiBoundary(value: IMcpServerEntity['phiBoundary']) {
    this.setProperty('phiBoundary', value);
  }

  get enabled(): IMcpServerEntity['enabled'] {
    return this._enabled;
  }

  set enabled(value: IMcpServerEntity['enabled']) {
    this.setProperty('enabled', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('MCP server name is required');
    }
    if (!this._baseUrl || this._baseUrl.trim().length === 0) {
      throw new BusinessException('MCP server baseUrl is required');
    }
    if (!ALLOWED_TRANSPORTS.has(this._transport)) {
      throw new BusinessException(`Unsupported MCP transport: ${this._transport}`);
    }
    if (!ALLOWED_PHI_BOUNDARIES.has(this._phiBoundary)) {
      throw new BusinessException(`Invalid MCP phiBoundary: ${this._phiBoundary}`);
    }
    // Defence in depth: authRef must be a Vault PATH, never inline secret
    // material. Reject anything that looks like an embedded credential.
    if (this._authRef && /\s/.test(this._authRef)) {
      throw new BusinessException('MCP authRef must be a Vault path, not secret material');
    }
  }
}
