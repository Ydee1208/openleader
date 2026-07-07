import { define } from "./internal"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ControlPlaneMoveSession } from "../control-plane/move-session"
import { EventV2 } from "../event"
import { Git } from "../git"
import { SessionV1 } from "../v1/session"
import { AbsolutePath } from "../schema"
import path from "path"

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
  "文件修改互不干扰，通过 PR 合并回主分支。",
  "",
  "## 核心规则",
  "",
  "1. 每个 session 是一个独立的 agent",
  "2. 每个 agent 在独立的 worktree 中工作",
  "3. 同一时间只关注当前 session 的任务",
  "",
  "## 可用命令",
  "",
  "- `/oleader-commit` — 提交变更到当前 agent 分支",
  "- `/oleader-pr` — 创建 Pull Request",
].join("\n")

export const Plugin = define({
  id: "openleader",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const git = yield* Git.Service
    const moveSession = yield* ControlPlaneMoveSession.Service

    ctx.skill.transform((draft) => {
      draft.source({
        type: "embedded",
        skill: {
          name: "openleader",
          description: "多 agent 并行开发工作流。每个 session 是一个独立的 agent，拥有独立的 git worktree。",
          location: "skill/SKILL.md",
          content: SKILL_CONTENT,
        },
      })
    })

    yield* events.subscribe(SessionV1.Event.Created).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = event.data.sessionID
          const projectDir = event.data.info.directory
          const absDir = AbsolutePath.make(projectDir)
          const proc = yield* ChildProcess.ChildProcess

          let repository = yield* git.repo.discover(absDir)

          if (!repository) {
            yield* Effect.logInfo("openleader: initializing git repo", { sessionID, directory: projectDir })
            const init = yield* proc.run(
              ChildProcess.make("git", ["init"], { cwd: projectDir, extendEnv: true, stdin: "ignore" }),
            )
            if (init.exitCode !== 0) {
              yield* Effect.logWarning("openleader: git init failed", { sessionID, error: init.stderr.toString("utf8") })
              return
            }
            yield* proc.run(
              ChildProcess.make("git", ["add", "-A"], { cwd: projectDir, extendEnv: true, stdin: "ignore" }),
            )

            yield* proc.run(
              ChildProcess.make("git", ["commit", "--allow-empty", "-m", "init"], {
                cwd: projectDir,
                extendEnv: true,
                stdin: "ignore",
              }),
            )

            repository = yield* git.repo.discover(absDir)
            if (!repository) return
          }

          const branchName = `agent/${sessionID}`
          const worktreeDir = AbsolutePath.make(
            path.join(repository.worktree, ".worktrees", sessionID),
          )

          yield* Effect.logInfo("openleader: setting up worktree", {
            sessionID,
            branch: branchName,
            worktree: worktreeDir,
          })

          const result = yield* Effect.gen(function* () {
            yield* git.worktree.create({ repository, directory: worktreeDir })

            yield* proc
              .run(
                ChildProcess.make("git", ["checkout", "-b", branchName], {
                  cwd: worktreeDir,
                  extendEnv: true,
                  stdin: "ignore",
                }),
              )
              .pipe(Effect.flatMap((r) => r.exitCode === 0 ? Effect.void : Effect.die("branch failed")))

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
        "- 主分支的最新代码已合并到当前分支",
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
    })
  }),
})
