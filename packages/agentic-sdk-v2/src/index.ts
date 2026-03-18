/**
 * @arcaai/vox
 *
 * ARCAAI Agentic SDK v2 for medical consultation workflows.
 *
 * This is the main entry point that includes everything:
 * - Core SDK functionality (providers, hooks, types, utilities)
 * - Plugin hooks and pipelines (STT, VAD, noise filter)
 *
 * For smaller bundles, use selective imports:
 * - `@arcaai/vox/core` - Core only (~200KB)
 * - `@arcaai/vox/plugins` - Plugins only
 *
 * Features:
 * - Simplified unified API with configuration-driven plugins
 * - React hooks for easy integration
 * - Support for noise cancellation, VAD, and STT
 * - Context management for case notes, transcriptions, and summaries
 * - Hybrid personalization (local + backend sync)
 * - Custom model registry support
 *
 * @example
 * ```tsx
 * import { AgenticProvider, useArca } from '@arcaai/vox';
 *
 * const config = {
 *   api: { baseUrl: 'https://api.arcaai.com', apiKey: 'your-key' },
 *   audio: {
 *     noiseFilter: { enabled: true, level: 'high' },
 *     vad: { enabled: true },
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
 *     await session.create({
 *       patientId: 'patient-123',
 *       appointmentDate: '2026-01-12',
 *       doctorId: 'doctor-456',
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
