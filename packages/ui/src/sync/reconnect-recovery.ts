import type { SessionStatus, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { getSessionMaterializationStatus } from "./materialization"

type ReconnectMaterializationState = {
  session: Session[]
  session_status?: Record<string, SessionStatus>
  message?: Record<string, Message[]>
  part?: Record<string, Part[]>
}

type ViewedSessionMaterializationTarget = {
  directory: string
  sessionId: string
}

type ReconnectCandidateOptions = {
  directory?: string
  viewedSession?: ViewedSessionMaterializationTarget | null
  maxCandidates?: number
}

type BootstrapSessionRevisionOptions = {
  baselineRevision: number
  eventRevision?: Record<string, number>
  deletedRevision?: Record<string, number>
}

const getParentId = (session: Session): string | null | undefined => (
  (session as Session & { parentID?: string | null }).parentID
)

const includeAncestorSessions = (
  parentIds: string[],
  includedIds: Set<string>,
  sessionsById: Map<string, Session>,
  excludedIds?: ReadonlySet<string>,
): void => {
  while (parentIds.length > 0) {
    const parentId = parentIds.pop()
    if (!parentId || includedIds.has(parentId) || excludedIds?.has(parentId)) continue
    const parent = sessionsById.get(parentId)
    if (!parent) continue
    includedIds.add(parentId)
    const ancestorId = getParentId(parent)
    if (ancestorId) parentIds.push(ancestorId)
  }
}

export function mergeBootstrapSessions(
  rootSessions: Session[],
  allSessions: Session[] | null,
  existingSessions: Session[],
  revisions?: BootstrapSessionRevisionOptions,
): { sessions: Session[]; rootCount: number } {
  const completeSessions = allSessions ?? existingSessions.filter(
    (session) => Boolean(getParentId(session)),
  )
  const rootIds = new Set(rootSessions.map((session) => session.id))
  const sessionsById = new Map(existingSessions.map((session) => [session.id, session]))
  for (const session of completeSessions) sessionsById.set(session.id, session)
  for (const session of rootSessions) sessionsById.set(session.id, session)

  const includedIds = new Set(rootIds)
  const pendingParentIds: string[] = []
  for (const session of completeSessions) {
    const parentId = getParentId(session)
    if (!parentId) continue
    includedIds.add(session.id)
    pendingParentIds.push(parentId)
  }
  includeAncestorSessions(pendingParentIds, includedIds, sessionsById)

  if (revisions) {
    const deletedIds = new Set(
      Object.entries(revisions.deletedRevision ?? {})
        .filter(([, revision]) => revision > revisions.baselineRevision)
        .map(([sessionId]) => sessionId),
    )
    for (const session of existingSessions) {
      if ((revisions.eventRevision?.[session.id] ?? 0) <= revisions.baselineRevision) continue
      sessionsById.set(session.id, session)
      includedIds.add(session.id)
      const parentId = getParentId(session)
      if (parentId) pendingParentIds.push(parentId)
    }
    for (const sessionId of deletedIds) includedIds.delete(sessionId)
    includeAncestorSessions(pendingParentIds, includedIds, sessionsById, deletedIds)
  }

  const sessions = [...includedIds]
    .map((id) => sessionsById.get(id))
    .filter((session): session is Session => Boolean(session))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rootCount = sessions.reduce((count, session) => (
    getParentId(session) ? count : count + 1
  ), 0)

  return { sessions, rootCount }
}

export function getReconnectCandidateSessionIds(state: ReconnectMaterializationState, options?: ReconnectCandidateOptions) {
  const viewedIds: string[] = []
  const nonIdleIds: string[] = []
  const incompleteIds: string[] = []

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") nonIdleIds.push(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      incompleteIds.push(sessionId)
    } else if (!getSessionMaterializationStatus({ message: state.message ?? {}, part: state.part ?? {} }, sessionId).renderable) {
      incompleteIds.push(sessionId)
    }
  }

  const viewedSession = options?.viewedSession
  if (viewedSession?.sessionId && viewedSession.directory === options?.directory) {
    const sessionId = viewedSession.sessionId
    const sessionExists = state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)
      || Object.hasOwn(state.message ?? {}, sessionId)

    if (sessionExists) {
      viewedIds.push(sessionId)
    }
  }

  const selectedChildIds = new Set([...viewedIds, ...nonIdleIds, ...incompleteIds])
  const parentByChildId = new Map<string, string>()
  for (const session of state.session) {
    if (!session?.id || !selectedChildIds.has(session.id)) continue
    const parentId = getParentId(session)
    if (parentId) parentByChildId.set(session.id, parentId)
  }

  const maxCandidates = options?.maxCandidates ?? 20
  const out: string[] = []
  const seen = new Set<string>()
  const add = (sessionId: string): boolean => {
    if (!sessionId || seen.has(sessionId) || out.length >= maxCandidates) return false
    seen.add(sessionId)
    out.push(sessionId)
    return true
  }
  const addCandidateWithParent = (sessionId: string) => {
    if (!sessionId || seen.has(sessionId)) return
    const parentId = parentByChildId.get(sessionId)
    if (parentId && !seen.has(parentId)) {
      if (out.length + 2 > maxCandidates) return
      if (!add(sessionId)) return
      add(parentId)
      return
    }
    add(sessionId)
  }

  const childIds = new Set(parentByChildId.keys())
  const nonIdleChildIds = nonIdleIds.filter((sessionId) => childIds.has(sessionId))
  const nonIdleRootIds = nonIdleIds.filter((sessionId) => !childIds.has(sessionId))
  const incompleteChildIds = incompleteIds.filter((sessionId) => childIds.has(sessionId))
  const incompleteRootIds = incompleteIds.filter((sessionId) => !childIds.has(sessionId))

  for (const sessionId of viewedIds) addCandidateWithParent(sessionId)
  for (const sessionId of nonIdleChildIds) addCandidateWithParent(sessionId)
  for (const sessionId of nonIdleRootIds) addCandidateWithParent(sessionId)
  for (const sessionId of incompleteChildIds) addCandidateWithParent(sessionId)
  for (const sessionId of incompleteRootIds) addCandidateWithParent(sessionId)

  return out
}
