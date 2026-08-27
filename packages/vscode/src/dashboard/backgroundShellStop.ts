export interface BackgroundShellClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function stopBackgroundShell(client: BackgroundShellClient, sessionId: string, jobId: string) {
  return client.extMethod('shell_stop', { sessionId, jobId });
}
