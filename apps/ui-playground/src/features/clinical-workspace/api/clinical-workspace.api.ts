/**
 * Clinical workspace API wrappers (TASK-330 P3).
 *
 * Thin functions over the SDK `AgenticClient` for the endpoints the SDK hooks
 * don't already surface (recording lifecycle, live-summary stream-ticket, dual
 * recordings, provenance, approve). Components obtain the client from
 * `useArcaStore((s) => s.apiClient)` and pass it in, keeping these unit-friendly
 * and free of React/store coupling.
 */
import type { AgenticClient } from '@arcaai/vox';
import { WORKSPACE_ENDPOINTS } from '../constants';
import type {
  AddAudioRecordingRequest,
  AddContextRequest,
  AudioRecordingItem,
  CreateHighlightRequest,
  CreateStreamSessionResponse,
  RecordingStateResponse,
  StreamTicketResponse,
  SummaryApprovalResponseDto,
  SummaryProvenanceResponse,
  WorkspaceContextItem,
  WorkspaceHighlight,
} from '../types';

/** Start the consultation recording (status → RECORDING). */
export function startRecording(client: AgenticClient, consultationId: string, sessionId?: string): Promise<RecordingStateResponse> {
  return client.post<RecordingStateResponse>(WORKSPACE_ENDPOINTS.startRecording(consultationId), sessionId ? { sessionId } : {});
}

/** Stop the consultation recording; optionally persist a final summary snapshot. */
export function stopRecording(client: AgenticClient, consultationId: string, persistSnapshot = true): Promise<RecordingStateResponse> {
  return client.post<RecordingStateResponse>(WORKSPACE_ENDPOINTS.stopRecording(consultationId), { persistSnapshot });
}

/** Create an STT streaming session bound to the consultation. */
export function createStreamSession(
  client: AgenticClient,
  input: { consultationId: string; pipelineId?: string; language?: string },
): Promise<CreateStreamSessionResponse> {
  return client.post<CreateStreamSessionResponse>(WORKSPACE_ENDPOINTS.streamSession, input);
}

/** Mint a one-shot SSE ticket for the given scope (EventSource can't set headers). */
export function fetchStreamTicket(client: AgenticClient, scope: string): Promise<StreamTicketResponse> {
  return client.post<StreamTicketResponse>(WORKSPACE_ENDPOINTS.streamTicket, { scope });
}

/** Build the authenticated live-summary SSE URL (`?ticket=` appended). */
export function buildLiveSummaryStreamUrl(client: AgenticClient, consultationId: string, ticket: string): string {
  const base = client.getBaseUrl();
  const path = WORKSPACE_ENDPOINTS.liveSummaryStream(consultationId);
  return `${base}${path}?ticket=${encodeURIComponent(ticket)}`;
}

/** Add a mid-visit context item (case note, work note, attachment, …). */
export function addContextItem(client: AgenticClient, consultationId: string, body: AddContextRequest): Promise<WorkspaceContextItem> {
  return client.post<WorkspaceContextItem>(WORKSPACE_ENDPOINTS.context(consultationId), { source: 'USER', ...body });
}

/** Soft-delete a mid-visit context item (case note, work note, attachment, …). */
export function deleteContextItem(client: AgenticClient, consultationId: string, contextId: string): Promise<unknown> {
  return client.delete<unknown>(WORKSPACE_ENDPOINTS.contextItem(consultationId, contextId));
}

/** Register a dual-capture (raw + processed) audio recording. */
export function registerDualRecording(client: AgenticClient, consultationId: string, body: AddAudioRecordingRequest): Promise<WorkspaceContextItem> {
  return client.post<WorkspaceContextItem>(WORKSPACE_ENDPOINTS.recordings(consultationId), body);
}

/** List the consultation's context items (artifacts/storage panel). */
export function fetchContextItems(client: AgenticClient, consultationId: string): Promise<WorkspaceContextItem[]> {
  return client.get<WorkspaceContextItem[]>(WORKSPACE_ENDPOINTS.context(consultationId));
}

/** List the consultation's audio recordings. */
export function fetchRecordings(client: AgenticClient, consultationId: string): Promise<AudioRecordingItem[]> {
  return client.get<AudioRecordingItem[]>(WORKSPACE_ENDPOINTS.recordings(consultationId));
}

/** Fetch the provenance/citations map for a drafted note. */
export function fetchProvenance(client: AgenticClient, consultationId: string, contextItemId: string): Promise<SummaryProvenanceResponse> {
  return client.get<SummaryProvenanceResponse>(WORKSPACE_ENDPOINTS.summaryProvenance(consultationId, contextItemId));
}

/** Approve + sign the draft note (status → SIGNED_NOTE). NEVER auto-called. */
export function approveNote(client: AgenticClient, consultationId: string, contextItemId: string): Promise<SummaryApprovalResponseDto> {
  return client.post<SummaryApprovalResponseDto>(WORKSPACE_ENDPOINTS.summaryApprove(consultationId, contextItemId), {});
}

/** Edit the draft note content before signing. */
export function updateSummaryContent(client: AgenticClient, consultationId: string, summaryId: string, content: string): Promise<unknown> {
  return client.patch<unknown>(WORKSPACE_ENDPOINTS.summaryUpdate(consultationId, summaryId), { content });
}

// ─── Manual highlights (TASK-344 Workstream B) ───────────────────────────────

/** List the consultation's manual doctor highlights. */
export function fetchHighlights(client: AgenticClient, consultationId: string): Promise<WorkspaceHighlight[]> {
  return client.get<WorkspaceHighlight[]>(WORKSPACE_ENDPOINTS.highlights(consultationId));
}

/** Persist a manual highlight anchored to a persisted surface. */
export function createHighlight(client: AgenticClient, consultationId: string, body: CreateHighlightRequest): Promise<WorkspaceHighlight> {
  return client.post<WorkspaceHighlight>(WORKSPACE_ENDPOINTS.highlights(consultationId), body);
}

/** Soft-delete a manual highlight. */
export function deleteHighlight(client: AgenticClient, consultationId: string, highlightId: string): Promise<unknown> {
  return client.delete<unknown>(WORKSPACE_ENDPOINTS.highlight(consultationId, highlightId));
}
