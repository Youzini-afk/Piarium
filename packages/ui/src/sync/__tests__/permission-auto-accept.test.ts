import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"

let serverPermissionAutoAcceptEnabled = false
let sessionAutoAccepting = false

mock.module("@/stores/useUIStore", () => ({
  useUIStore: {
    getState: () => ({ serverPermissionAutoAcceptEnabled }),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => sessionAutoAccepting }),
  },
}))

import {
  autoAcceptGroupedPermissions,
  shouldAutoAcceptPermissionForSession,
} from "../permission-auto-accept"

function buildPermission(id: string, sessionID = "ses_a"): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "external_directory",
    patterns: ["/tmp/*"],
    metadata: {},
    always: [],
  } as PermissionRequest
}

describe("permission auto-accept helpers", () => {
  beforeEach(() => {
    serverPermissionAutoAcceptEnabled = false
    sessionAutoAccepting = false
  })

  test("server-wide auto-accept overrides session-level state", () => {
    serverPermissionAutoAcceptEnabled = true
    sessionAutoAccepting = false

    expect(shouldAutoAcceptPermissionForSession("ses_a")).toBe(true)
  })

  test("filters permissions that were auto-accepted", async () => {
    serverPermissionAutoAcceptEnabled = true
    const accepted: string[] = []

    const result = await autoAcceptGroupedPermissions({
      ses_a: [buildPermission("perm_1"), buildPermission("perm_2")],
    }, async (permission) => {
      accepted.push(permission.id)
    })

    expect(accepted.sort()).toEqual(["perm_1", "perm_2"])
    expect(result).toEqual({})
  })

  test("keeps permissions visible when auto-accept reply fails", async () => {
    serverPermissionAutoAcceptEnabled = true
    const permission = buildPermission("perm_1")

    const result = await autoAcceptGroupedPermissions({
      ses_a: [permission],
    }, async () => {
      throw new Error("reply failed")
    })

    expect(result).toEqual({ ses_a: [permission] })
  })
})
