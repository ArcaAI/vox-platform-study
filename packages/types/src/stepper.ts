/**
 * Stepper Component Types
 *
 * Type definitions for stepper/wizard components using @stepperize/react
 */

/**
 * Voice enrollment steps
 */
export const VOICE_ENROLLMENT_STEPS = ['setup', 'enrolling', 'enrolled'] as const;
export type VoiceEnrollmentStep = typeof VOICE_ENROLLMENT_STEPS[number];

/**
 * Voice enrollment wizard steps (more detailed)
 */
export const VOICE_ENROLLMENT_WIZARD_STEPS = ['name', 'instructions', 'recording', 'processing', 'success'] as const;
export type VoiceEnrollmentWizardStep = typeof VOICE_ENROLLMENT_WIZARD_STEPS[number];

/**
 * Step metadata for display
 */
export interface StepMetadata {
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

/**
 * Stepper configuration
 */
export interface StepperConfig<T extends readonly string[]> {
  steps: T;
  initialStep?: number;
  metadata?: Record<T[number], StepMetadata>;
}

