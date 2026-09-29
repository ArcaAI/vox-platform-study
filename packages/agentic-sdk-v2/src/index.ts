/**
 * @arcaai/vox
 *
 * ARCAAI Agentic SDK v2 for medical consultation workflows.
 *
 * This is the main entry point that includes everything:
 * - Core SDK functionality (providers, hooks, types, utilities)
 * - Plugin hooks and pipelines (audio capture, backend streaming STT, TTS playback)
 *
 * For smaller bundles, use selective imports:
 * - `@arcaai/vox/core` - Core only (~200KB)
 * - `@arcaai/vox/plugins` - Plugins only
 *
 * Features:
 * - Simplified unified API with configuration-driven plugins
 * - React hooks for easy integration
 * - Backend streaming STT — the browser never runs a model; ASR is the tenant's Agent (`agentSlug`)
 * - Context management for case notes, transcriptions, and summaries
 * - Hybrid personalization (local + backend sync)
 *
 * @example
 * ```tsx
 * import { AgenticProvider, useArca } from '@arcaai/vox';
 *
 * const config = {
 *   api: { baseUrl: 'https://api.arcaai.com', apiKey: 'your-key' },
 *   audio: {
 *     stt: { enabled: true, language: 'en' },
 *   },
 * };
 *
 * function App() {
 *   return (
 *     <AgenticProvider config={config}>
 *       <ConsultationPage />
 *     </AgenticProvider>
 *   );
 * }
 *
 * function ConsultationPage() {
 *   const { session, audio, context, summary, isReady } = useArca();
 *
 *   const handleStart = async () => {
 *     await session.open({
 *       patientId: 'patient-123',
 *       appointmentDate: '2026-01-12',
 *     });
 *     await audio.start();
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleStart}>Start Consultation</button>
 *       <div>Audio Level: {audio.level}%</div>
 *     </div>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Core Exports (No Plugin Dependencies)
// =============================================================================

export * from './core.js';

// =============================================================================
// Plugin Exports (STT, VAD, Noise Filter)
// =============================================================================

export * from './plugins.js';
