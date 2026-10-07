/**
 * TASK-1050 W2e — the lowercase guardrail WIRE vocabulary (`@arcaai/types`) ↔ the W0 Prisma enums,
 * and the notice row → client view mapping. Pure: no I/O.
 *
 * Resolves the `prismaMappingTodo` of `tests/contracts/guardrail-vocabulary.fixture.json` for the
 * gateway writer: wire values are lowercase, the rows store SCREAMING_CASE enums. Notices are deduped
 * by guardrail's deterministic `noticeId`, so no gateway-side dedupe key is composed here.
 */
import {
  GuardrailDecision,
  GuardrailDirection,
  GuardrailNoticeType,
  type GuardrailItemStatus,
  type GuardrailNoticeEntity,
  type GuardrailNoticeStatus,
} from '@arcaai/domains';
import type {
  GuardrailAcknowledgementVia,
  GuardrailDecision as WireDecision,
  GuardrailDirection as WireDirection,
  GuardrailNotice,
  GuardrailNoticeAcknowledgement,
  GuardrailNoticeCheck,
  GuardrailNoticeMessageKey,
  GuardrailNoticeType as WireNoticeType,
} from '@arcaai/types';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, GUARDRAIL_NOTICE_SCHEMA_VERSION } from '@arcaai/types';

export function directionToRow(direction: WireDirection): GuardrailDirection {
  return direction === 'outbound' ? GuardrailDirection.OUTBOUND : GuardrailDirection.INBOUND;
}

export function directionFromRow(direction: GuardrailDirection | string): WireDirection {
  return String(direction) === 'OUTBOUND' ? 'outbound' : 'inbound';
}

export function decisionToRow(decision: WireDecision): GuardrailDecision {
  switch (decision) {
    case 'block':
      return GuardrailDecision.BLOCK;
    case 'warn':
      return GuardrailDecision.WARN;
    case 'unverified':
      return GuardrailDecision.UNVERIFIED;
    default:
      return GuardrailDecision.ALLOW;
  }
}

export function decisionFromRow(decision: GuardrailDecision | string): WireDecision {
  return String(decision).toLowerCase() as WireDecision;
}

export function noticeTypeToRow(type: WireNoticeType): GuardrailNoticeType {
  switch (type) {
    case 'guardrail.blocked':
      return GuardrailNoticeType.BLOCKED;
    case 'guardrail.unverified':
      return GuardrailNoticeType.UNVERIFIED;
    default:
      return GuardrailNoticeType.WARNING;
  }
}

export function noticeTypeFromRow(type: GuardrailNoticeType | string): WireNoticeType {
  switch (String(type)) {
    case 'BLOCKED':
      return 'guardrail.blocked';
    case 'UNVERIFIED':
      return 'guardrail.unverified';
    default:
      return 'guardrail.warning';
  }
}

/** Marker strength: a marker only ever moves up this ladder (never downgraded by a verdict). */
const ITEM_STATUS_RANK: Readonly<Record<string, number>> = { CLEAN: 0, WARNED: 1, BLOCKED: 2, WITHHELD: 3 };

export function itemStatusRank(status: GuardrailItemStatus | string | null | undefined): number {
  return ITEM_STATUS_RANK[String(status ?? 'CLEAN')] ?? 0;
}

export function strongerItemStatus(a: GuardrailItemStatus | undefined, b: GuardrailItemStatus): GuardrailItemStatus {
  return a !== undefined && itemStatusRank(a) >= itemStatusRank(b) ? a : b;
}

/** The highest check severity of a notice: the row's `severity` column. */
export function noticeSeverity(checks: readonly GuardrailNoticeCheck[]): 'low' | 'medium' | 'high' {
  if (checks.some((check) => check.severity === 'high')) return 'high';
  if (checks.some((check) => check.severity === 'medium')) return 'medium';
  // A check-less notice (the redaction hold) is still a stop: high weight.
  return checks.length === 0 ? 'high' : 'low';
}

/** The domain's `acknowledgedVia` ('notice' | 'approve') on the wire ('ack' | 'approve' | 'resume'). */
export function acknowledgedViaFromRow(via: string | null | undefined): GuardrailAcknowledgementVia {
  if (via === 'approve') return 'approve';
  if (via === 'resume') return 'resume';
  return 'ack';
}

export function acknowledgementOf(notice: GuardrailNoticeEntity): GuardrailNoticeAcknowledgement | null {
  if (!notice.acknowledgedBy || !notice.acknowledgedAt) return null;
  return {
    noticeId: notice.id,
    acknowledgedBy: notice.acknowledgedBy,
    acknowledgedVia: acknowledgedViaFromRow(notice.acknowledgedVia),
    acknowledgedAt: new Date(notice.acknowledgedAt).toISOString(),
  };
}

/** A stored notice as the client reads it: the `GuardrailNotice` v1 body plus its state. PHI-free. */
export interface GuardrailNoticeView extends GuardrailNotice {
  readonly status: 'open' | 'acknowledged' | 'resolved';
  readonly acknowledgement: GuardrailNoticeAcknowledgement | null;
  readonly resolution: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
}

function checksOf(raw: unknown): GuardrailNoticeCheck[] {
  return Array.isArray(raw) ? (raw.filter((entry) => entry && typeof entry === 'object') as GuardrailNoticeCheck[]) : [];
}

export function toNoticeView(notice: GuardrailNoticeEntity): GuardrailNoticeView {
  const type = noticeTypeFromRow(notice.type);
  const messageKey = notice.messageKey as GuardrailNoticeMessageKey;
  return {
    schemaVersion: GUARDRAIL_NOTICE_SCHEMA_VERSION,
    noticeId: notice.id,
    type,
    direction: directionFromRow(notice.direction),
    action: notice.action === 'block' ? 'block' : 'warn',
    checks: checksOf(notice.checks),
    ...(notice.consultationId ? { consultationId: notice.consultationId } : {}),
    ...(notice.runId ? { runId: notice.runId } : {}),
    ...(notice.nodeId ? { nodeId: notice.nodeId } : {}),
    itemIds: [...(notice.itemIds ?? [])],
    messageKey,
    // Never stored: always the fixed label of the key, so a row can never carry free text.
    defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES[messageKey] ?? GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
    requiresAcknowledgement: notice.requiresAcknowledgement,
    resumable: notice.resumable,
    policyVersion: notice.policyVersion,
    occurredAt: new Date(notice.createdAt).toISOString(),
    status: String(notice.status) === 'RESOLVED' ? 'resolved' : String(notice.status) === 'ACKNOWLEDGED' ? 'acknowledged' : 'open',
    acknowledgement: acknowledgementOf(notice),
    resolution: notice.resolution ?? null,
    resolvedBy: notice.resolvedBy ?? null,
    resolvedAt: notice.resolvedAt ? new Date(notice.resolvedAt).toISOString() : null,
  };
}

export function isOpenNotice(notice: { status: GuardrailNoticeStatus | string }): boolean {
  return String(notice.status) === 'OPEN';
}

export function isUnresolvedNotice(notice: { status: GuardrailNoticeStatus | string }): boolean {
  return String(notice.status) !== 'RESOLVED';
}

export function isBlockNotice(notice: { type: GuardrailNoticeType | string }): boolean {
  return String(notice.type) === 'BLOCKED';
}
