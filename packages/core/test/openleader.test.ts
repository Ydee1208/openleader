import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { setupWorktree } from "@opencode-ai/core/plugin/openleader"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Git } from "@opencode-ai/core/git"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      MoveSession.node,
      AppProcess.node,
      Database.node,
      EventV2.node,
      Git.node,
      FSUtil.node,
      ProjectDirectories.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
    ]),
  ),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

describe("setupWorktree", () => {
  it.live("creates a worktree and branch for a session in an existing git repo", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const projectDir = abs(yield* Effect.promise(() => fs.realpath(tmp.path)))
      const sessionID = SessionV2.ID.make("ses_openleader_test1")

      const git = yield* Git.Service
      const proc = yield* AppProcess.Service
      const moveSession = yield* MoveSession.Service

      const projectID = (yield* Project.Service.use((service) => service.resolve(projectDir))).id
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: projectDir, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "openleader-test1",
          directory: projectDir,
          title: "openleader test1",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* setupWorktree(sessionID, projectDir, git, proc, moveSession)

      const worktreesText = yield* Effect.promise(() => $`git worktree list`.cwd(projectDir).text())
      const lines = worktreesText.trim().split("\n")
      expect(lines.length).toBeGreaterThanOrEqual(2)

      const worktreeDirs = lines.map((l) => l.split(/\s+/)[0])
      const linked = worktreeDirs.slice(1)
      expect(linked.length).toBe(1)

      const branch = yield* Effect.promise(() => $`git -C ${linked[0]} branch --show-current`.cwd(projectDir).text())
      expect(branch.trim()).toBe(`agent/${sessionID}`)

      const record = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
      expect(record?.directory).toBe(path.resolve(linked[0]))
    }),
  )

  it.live("initializes a git repo and creates worktree when no repo exists", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const projectDir = abs(yield* Effect.promise(() => fs.realpath(tmp.path)))
      const sessionID = SessionV2.ID.make("ses_openleader_test2")

      const git = yield* Git.Service
      const proc = yield* AppProcess.Service
      const moveSession = yield* MoveSession.Service

      yield* setupWorktree(sessionID, projectDir, git, proc, moveSession)

      const worktreesText = yield* Effect.promise(() => $`git worktree list`.cwd(projectDir).text())
      const lines = worktreesText.trim().split("\n")
      expect(lines.length).toBeGreaterThanOrEqual(2)

      const worktreeDirs = lines.map((l) => l.split(/\s+/)[0])
      const linked = worktreeDirs.slice(1)
      expect(linked.length).toBe(1)

      const branch = yield* Effect.promise(() => $`git -C ${linked[0]} branch --show-current`.cwd(projectDir).text())
      expect(branch.trim()).toBe(`agent/${sessionID}`)

      expect(yield* Effect.promise(() => fs.stat(linked[0]).then(() => true).catch(() => false))).toBe(true)
    }),
  )

  it.live("sets up .gitignore when initializing a new repo", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const projectDir = abs(yield* Effect.promise(() => fs.realpath(tmp.path)))
      const sessionID = SessionV2.ID.make("ses_openleader_test3")

      const git = yield* Git.Service
      const proc = yield* AppProcess.Service
      const moveSession = yield* MoveSession.Service

      const projectID = (yield* Project.Service.use((service) => service.resolve(projectDir))).id
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: projectDir, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "openleader-test3",
          directory: projectDir,
          title: "openleader test3",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* setupWorktree(sessionID, projectDir, git, proc, moveSession)

      const gitignoreContent = yield* Effect.promise(() =>
        fs.readFile(path.join(projectDir, ".gitignore"), "utf8").catch(() => ""),
      )
      expect(gitignoreContent).toContain("node_modules/")

      const repository = yield* git.repo.discover(projectDir)
      if (repository) {
        const worktreesText = yield* Effect.promise(() => $`git worktree list`.cwd(projectDir).text())
        const lines = worktreesText.trim().split("\n")
        const linked = lines.slice(1).map((l) => l.split(/\s+/)[0])
        for (const dir of linked) {
          yield* Effect.promise(() => $`git worktree remove --force ${dir}`.cwd(projectDir).quiet().catch(() => {}))
        }
      }
    }),
  )
})
