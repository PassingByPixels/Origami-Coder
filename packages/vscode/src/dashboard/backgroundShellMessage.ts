import { stopBackgroundShell, type BackgroundShellClient } from './backgroundShellStop';

export function handleBackgroundShellStop(
  client: BackgroundShellClient | null | undefined,
  sessionId: string | undefined,
  jobId: unknown,
  failed: (message: string) => void,
) {
  if (!client || !sessionId || typeof jobId !== 'string' || !jobId) return;
  stopBackgroundShell(client, sessionId, jobId).catch(e =>
    failed(`Background shell stop failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}
