import { AccountApiClient, ApiError } from "./api/client";

/**
 * Signs out the current first-party browser session using documented Account commands.
 * Other devices and Subscribe BFF sessions are unaffected. An expired session is already signed out.
 * Missing current-session data is an error, never a reason to revoke all devices or claim success.
 */
export async function signOutCurrentSession(api: AccountApiClient, csrfToken: string): Promise<void> {
  try {
    const sessions = await api.listSessions();
    const current = sessions.items.find((session) => session.is_current && !session.revoked_at);
    if (!current) throw new Error("Current Identity session was not found");
    await api.revokeSession(current.session_id, { csrfToken, idempotencyKey: crypto.randomUUID() });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
  }
}
