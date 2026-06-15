import MyPromptsPage from '@/features/prompts';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/prompts')({
  component: MyPromptsPage,
});
