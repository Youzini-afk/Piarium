import { describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"

describe("useProjectsStore settings synchronization", () => {
  test("treats a successful empty project snapshot as authoritative", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })

  test("preserves an explicit no-workspace selection while projects remain available", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({
      activeProjectId: null,
      projects: [project],
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toHaveLength(1)
    expect(useProjectsStore.getState().projects[0]?.label).toBe(project.label)
    expect(useProjectsStore.getState().projects[0]?.path).toBe(project.path)
    expect(useProjectsStore.getState().activeProjectId).toBeNull()
  })
})
