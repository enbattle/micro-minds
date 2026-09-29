/**
 * Where a session's hooks post: `POST /hooks` (PLAN §5.1), with our session id in the query so the
 * ingest can find the session and its token before it parses anything (D29).
 */
export function hookEndpoint(serverUrl: string, sessionId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/hooks?session=${encodeURIComponent(sessionId)}`;
}
