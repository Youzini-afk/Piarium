import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"

import { usePermissionStore } from "@/stores/permissionStore"
import { useUIStore } from "@/stores/useUIStore"
import type { DirectoryStore } from "./child-store"

export function shouldAutoAcceptPermissionForSession(sessionID: string | null | undefined): boolean {
  if (useUIStore.getState().serverPermissionAutoAcceptEnabled === true) {
    return true
  }
  if (!sessionID) {
    return false
  }
  return usePermissionStore.getState().isSessionAutoAccepting(sessionID)
}

export function removePermissionRequestFromStore(
  store: StoreApi<DirectoryStore>,
  sessionID: string | null | undefined,
  requestID: string | null | undefined,
): void {
  if (!requestID) return

  store.setState((state: DirectoryStore) => {
    let changed = false
    const nextPermission = { ...state.permission }
    const sessionIds = new Set<string>([
      ...(sessionID ? [sessionID] : []),
      ...Object.keys(state.permission ?? {}),
    ])

    for (const candidateSessionID of sessionIds) {
      const current = nextPermission[candidateSessionID]
      if (!current?.length) continue
      const next = current.filter((permission) => permission.id !== requestID)
      if (next.length === current.length) continue
      changed = true
      if (next.length > 0) {
        nextPermission[candidateSessionID] = next
      } else {
        delete nextPermission[candidateSessionID]
      }
    }

    return changed ? { permission: nextPermission } : state
  })
}

export async function autoAcceptGroupedPermissions(
  grouped: Record<string, PermissionRequest[]>,
  accept: (permission: PermissionRequest) => Promise<void>,
): Promise<Record<string, PermissionRequest[]>> {
  const acceptedIdsBySession = new Map<string, Set<string>>()

  await Promise.all(Object.entries(grouped).flatMap(([sessionID, permissions]) => {
    if (!shouldAutoAcceptPermissionForSession(sessionID)) {
      return []
    }
    return permissions.map(async (permission) => {
      try {
        await accept(permission)
        const accepted = acceptedIdsBySession.get(sessionID) ?? new Set<string>()
        accepted.add(permission.id)
        acceptedIdsBySession.set(sessionID, accepted)
      } catch {
        // Keep failed auto-accept permissions in UI state so the user can act.
      }
    })
  }))

  if (acceptedIdsBySession.size === 0) {
    return grouped
  }

  const remaining: Record<string, PermissionRequest[]> = { ...grouped }
  for (const [sessionID, acceptedIds] of acceptedIdsBySession) {
    const next = (remaining[sessionID] ?? []).filter((permission) => !acceptedIds.has(permission.id))
    if (next.length > 0) {
      remaining[sessionID] = next
    } else {
      delete remaining[sessionID]
    }
  }
  return remaining
}
