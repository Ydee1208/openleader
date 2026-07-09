import { define } from "./internal"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import { MoveSession } from "../control-plane/move-session"
import { EventV2 } from "../event"
import { Git } from "../git"
import { SessionV2 } from "../session"
import { SessionV1 } from "../v1/session"
import { SessionSchema } from "../session/schema"
import { SkillV2 } from "../skill"
import { AbsolutePath } from "../schema"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { existsSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import path from "path"

const GITIGNORE_CONTENT = [
  "node_modules/",
  "dist/",
  ".env",
  "",
].join("\n")

const SKILL_CONTENT = [
  "---",
  "name: openleader",
  "description: 多 agent 并行开发工作流。每个 session 是一个独立的 agent，拥有独立的 git worktree。",
  "---",
  "",
  "# openleader 工作流",
  "",
  "本项目使用 openleader 管理多个并行的开发 agent。",
  "每个 session 是一个 agent，在独立的 git worktree 中工作。",
  "文件修改互不干扰，通过 PR 合并回默认分支。",
  "",
  "## 核心规则",
  "",
  "1. 每个 session 是一个独立的 agent",
  "2. 每个 agent 在独立的 worktree 中工作",
  "3. 同一时间只关注当前 session 的任务",
  "4. fork session 从父 session 的 branch tip 派生，继承代码状态",
  "",
  "## 可用命令",
  "",
  "- `/oleader-commit` — 提交变更到当前 agent 分支",
  "- `/oleader-pr` — 创建 Pull Request",
  "- `/oleader-status` — 查看当前分支和状态",
  "- `/oleader-context` — 查看当前 session 的上下文信息（worktree、分支、fork 关系）",
].join("\n")

export function run(proc: AppProcess.Interface, cwd: string | AbsolutePath, args: string[], stdin?: string) {
  return proc.run(
    ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: stdin ? "pipe" : "ignore" }),
    stdin ? { stdin } : undefined,
  )
}

export function setupWorktree(
  sessionID: SessionSchema.ID,
  projectDir: string,
  git: Git.Interface,
  proc: AppProcess.Interface,
  moveSession: MoveSession.Interface,
) {
  return Effect.gen(function* () {
    const absDir = AbsolutePath.make(projectDir)

    let repository = yield* git.repo.discover(absDir)

    if (!repository) {
      yield* Effect.logInfo("openleader: initializing git repo", { sessionID, directory: projectDir })

      const init = yield* run(proc, projectDir, ["init"])
      if (init.exitCode !== 0) {
        yield* Effect.logWarning("openleader: git init failed", { sessionID, error: init.stderr.toString("utf8") })
        return
      }

      yield* Effect.sync(() => {
        const gitignorePath = path.join(projectDir, ".gitignore")
        if (!existsSync(gitignorePath)) {
          writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf8")
        }
      }).pipe(Effect.catch(() =>
        Effect.logWarning("openleader: could not create .gitignore"),
      ))

      const add = yield* run(proc, projectDir, ["add", "-A"])
      if (add.exitCode !== 0) {
        yield* Effect.logWarning("openleader: git add failed", { sessionID })
        return
      }

      const commit = yield* run(proc, projectDir, ["commit", "--allow-empty", "-m", "init"])
      if (commit.exitCode !== 0) {
        yield* Effect.logWarning("openleader: git init commit failed", { sessionID })
        return
      }

      repository = yield* git.repo.discover(absDir)
      if (!repository) return
    }

    const projectTag = createHash("md5").update(repository.worktree).digest("hex").slice(0, 8)
    const branchName = `agent/${sessionID}`
    const worktreeDir = AbsolutePath.make(
      path.resolve(repository.worktree, ".opencode-worktrees", projectTag, sessionID),
    )

    yield* Effect.logInfo("openleader: setting up worktree", {
      sessionID,
      branch: branchName,
      worktree: worktreeDir,
    })

    const result = yield* Effect.gen(function* () {
      yield* git.worktree.create({ repository, directory: worktreeDir })

      const branch = yield* run(proc, worktreeDir, ["checkout", "-b", branchName])
      if (branch.exitCode !== 0) {
        return yield* new Git.WorktreeError({
          operation: "create",
          directory: worktreeDir,
          message: `Failed to create branch ${branchName}: ${branch.stderr.toString("utf8")}`,
        })
      }

      yield* moveSession.moveSession({
        sessionID,
        destination: { directory: worktreeDir },
        moveChanges: false,
      })
    }).pipe(Effect.exit)

    if (result._tag === "Failure") {
      yield* Effect.logWarning("openleader: worktree setup failed", {
        sessionID,
        error: String(result.cause),
      })
    }
  })
}

function forkContextMessage(sessionID: SessionSchema.ID, parentID: SessionSchema.ID, forkBranch: string, worktreeDir: AbsolutePath) {
  return [
    "## 上下文变更：此 session 是从其他 session fork 而来的",
    "",
    `- Session ID: ${sessionID}`,
    `- 父 Session ID: ${parentID}`,
    `- 分支: ${forkBranch}`,
    `- Worktree 路径: ${worktreeDir}`,
    "",
    "历史对话中的文件路径可能指向旧 worktree，使用以上分支和路径作为真实上下文。",
    "父 session 的所有未提交更改已被 patch 携带到当前 worktree。",
  ].join("\n")
}

export function setupForkWorktree(
  sessionID: SessionSchema.ID,
  parentID: SessionSchema.ID,
  projectDir: string,
  git: Git.Interface,
  proc: AppProcess.Interface,
  moveSession: MoveSession.Interface,
  sessionV2: SessionV2.Interface,
) {
  return Effect.gen(function* () {
    const absDir = AbsolutePath.make(projectDir)

    const repository = yield* git.repo.discover(absDir)
    if (!repository) {
      yield* Effect.logWarning("openleader: fork needs git repo, falling back to fresh setup", { sessionID, parentID })
      const fallbackBranch = `agent/${sessionID}`
      const fallbackDir = AbsolutePath.make(projectDir)
      yield* sessionV2.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: forkContextMessage(sessionID, parentID, fallbackBranch, fallbackDir) }), delivery: "steer", resume: false })
      return
    }

    const projectTag = createHash("md5").update(repository.worktree).digest("hex").slice(0, 8)
    const parentBranch = `agent/${parentID}`
    const forkBranch = `agent/${sessionID}`
    const parentWorktreeDir = AbsolutePath.make(
      path.resolve(repository.worktree, ".opencode-worktrees", projectTag, parentID),
    )
    const worktreeDir = AbsolutePath.make(
      path.resolve(repository.worktree, ".opencode-worktrees", projectTag, sessionID),
    )

    yield* Effect.logInfo("openleader: setting up fork worktree", {
      sessionID,
      parentID,
      parentBranch,
      forkBranch,
      worktree: worktreeDir,
    })

    const result = yield* Effect.gen(function* () {
      const diff = yield* run(proc, parentWorktreeDir, ["diff", "HEAD"])
      const patchContent = diff.stdout.toString("utf8").trim()

      const createBranch = yield* run(proc, repository.worktree, ["branch", forkBranch, parentBranch])
      if (createBranch.exitCode !== 0) {
        yield* Effect.logWarning("openleader: parent branch not found, falling back to HEAD", {
          sessionID,
          parentID,
          error: createBranch.stderr.toString("utf8"),
        })
        yield* run(proc, repository.worktree, ["branch", forkBranch, "HEAD"])
      }

      yield* git.worktree.create({ repository, directory: worktreeDir, ref: forkBranch })

      if (patchContent) {
        const apply = yield* run(proc, worktreeDir, ["apply", "-"], patchContent)
        if (apply.exitCode !== 0) {
          yield* Effect.logWarning("openleader: could not apply parent diff to fork", {
            sessionID,
            error: apply.stderr.toString("utf8"),
          })
        }
      }

      yield* moveSession.moveSession({
        sessionID,
        destination: { directory: worktreeDir },
        moveChanges: false,
      })

      yield* sessionV2.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: forkContextMessage(sessionID, parentID, forkBranch, worktreeDir) }), delivery: "steer", resume: false })
    }).pipe(Effect.exit)

    if (result._tag === "Failure") {
      yield* Effect.logWarning("openleader: fork worktree setup failed, falling back to fresh setup", {
        sessionID,
        parentID,
        error: String(result.cause),
      })
      yield* sessionV2.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: forkContextMessage(sessionID, parentID, forkBranch, worktreeDir) }), delivery: "steer", resume: false })
    }
  })
}

export const Plugin = define({
  id: "openleader",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const git = yield* Git.Service
    const moveSession = yield* MoveSession.Service
    const proc = yield* AppProcess.Service
    const sessionV2 = yield* SessionV2.Service

    ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "openleader",
            description: "多 agent 并行开发工作流。每个 session 是一个独立的 agent，拥有独立的 git worktree。",
            location: AbsolutePath.make("skill/SKILL.md"),
            content: SKILL_CONTENT,
          }),
        }),
      )
    })

    yield* events.subscribe(SessionV1.Event.Created).pipe(
      Stream.runForEach((event) => {
        if (event.data.info.parentID) {
          return setupForkWorktree(event.data.sessionID, event.data.info.parentID, event.data.info.directory, git, proc, moveSession, sessionV2).pipe(Effect.catch(() => Effect.void))
        }
        return setupWorktree(event.data.sessionID, event.data.info.directory, git, proc, moveSession).pipe(Effect.catch(() => Effect.void))
      }),
      Effect.forkScoped,
    )

    yield* events.subscribe(SessionV1.Event.Deleted).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = event.data.sessionID
          const worktreeDir = AbsolutePath.make(event.data.info.directory)

          const repository = yield* git.repo.discover(worktreeDir)
          if (!repository) return

          yield* Effect.logInfo("openleader: cleaning up worktree", { sessionID, worktree: worktreeDir })

          yield* git.worktree.remove({ repository, directory: worktreeDir, force: true }).pipe(
            Effect.catch(() =>
              Effect.logWarning("openleader: worktree removal failed", { sessionID }),
            ),
          )
        }),
      ),
      Effect.forkScoped,
    )

    ctx.command.transform((draft) => {
      const commit = [
        "请将当前工作区的变更提交到当前 agent 分支。执行以下操作：",
        "",
        "1. `git status` 查看变更",
        "2. `git add -A` 暂存所有变更",
        "3. 运行 lint 和类型检查确保代码质量",
        "4. `git commit -m \"提交信息\"`",
        "5. 通知用户提交完成（提供 commit hash）",
      ].join("\n")

      const pr = [
        "为当前 agent 分支创建 Pull Request。执行以下操作：",
        "",
        "1. 确认所有修改已提交: `git status`",
        "2. 推送分支到远程: `git push -u origin HEAD`",
        '3. 创建 PR: `gh pr create --fill --title "PR 标题"`',
        "4. 提供 PR 链接给用户审查",
        "",
        "在创建 PR 前确保：",
        "- 代码已通过 lint 和类型检查",
        "- 测试已通过",
        "- 默认分支的最新代码已合并到当前分支",
      ].join("\n")

      const status = [
        "查看当前 openleader agent 的状态。执行：",
        "",
        "1. `git branch --show-current` 查看当前分支",
        "2. `git status` 查看文件变更",
        "3. `git log --oneline -5` 查看最近提交",
        "4. 向用户汇报状态摘要",
      ].join("\n")

      draft.update("oleader-commit", (cmd) => {
        cmd.template = commit
        cmd.description = "提交当前 agent 的变更到 git"
        cmd.subtask = true
      })

      draft.update("oleader-pr", (cmd) => {
        cmd.template = pr
        cmd.description = "为当前 agent 分支创建 Pull Request"
        cmd.subtask = true
      })

      draft.update("oleader-status", (cmd) => {
        cmd.template = status
        cmd.description = "查看当前 openleader agent 的状态"
      })

      const context = [
        "查看当前 openleader agent 的上下文信息。执行以下操作：",
        "",
        "1. `git branch --show-current` 查看当前分支名称",
        "2. `git rev-parse --show-toplevel` 查看 worktree 根目录",
        "3. `git status` 查看文件变更",
        "4. `git log --oneline -3` 查看最近提交",
        "5. 检查 `git log --oneline -1` 中是否包含 `openleader:` 前缀的 checkpoint commit",
        "6. 向用户汇报：session ID、分支、worktree 路径、是否有未提交变更、是否为 fork、commit 数量",
        "",
        "注意：如果此 session 是从其他 session fork 而来，历史消息中的文件路径",
        "可能指向旧 worktree。使用当前分支和 worktree 路径作为真实上下文。",
      ].join("\n")

      draft.update("oleader-context", (cmd) => {
        cmd.template = context
        cmd.description = "查看当前 session 的上下文信息（worktree、分支、fork 关系）"
      })
    })
  }),
})
