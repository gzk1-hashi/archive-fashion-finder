/**
 * Typed client for the server actions in src/actions/index.ts.
 *
 * Reads and simple writes go straight through the realtime RecordRoom
 * (useQuery / useMutations, RBAC-checked server-side). Anything that needs
 * server authority — enqueueing an owner-billed job, a cascading delete — goes
 * through an action, here.
 */

import { getAuthToken } from 'deepspace'

export type ActionResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: Record<string, unknown> }

async function callAction<T>(name: string, params: Record<string, unknown>): Promise<ActionResponse<T>> {
  const token = await getAuthToken()
  if (!token) return { success: false, error: 'Sign in to continue.', code: 'unauthorized' }
  let res: Response
  try {
    res = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
  } catch {
    return { success: false, error: 'Network error — check your connection.', code: 'network' }
  }
  const body = (await res.json().catch(() => null)) as ActionResponse<T> | { error?: string } | null
  if (body && 'success' in body) return body
  return { success: false, error: body?.error ?? `Request failed (${res.status})`, code: String(res.status) }
}

export const startScan = (huntId: string) => callAction<{ jobId: string }>('startScan', { huntId })
export const deleteHunt = (huntId: string) => callAction<{ removed: number }>('deleteHunt', { huntId })
