import { define } from "@opencode-ai/plugin/v2/promise"

const SKILL_CONTENT = [
  "---",
  "name: openleader",
  "description: 多 agent 并行开发工作流。每个 session 是一个独立的 agent，拥有独立的 git 分支。",
  "---",
  "",
  "# openleader 工作流",
  "",
  "本项目使用 openleader 管理多个并行的开发 agent。",
  "",
  "## 核心规则",
  "",
  "1. 每个 opencode session 是一个独立的开发 agent",
  "2. 每个 agent 在独立的 git 分支上工作",
  "3. 分支命名格式: `agent/<goal-summary>`",
  "4. 同一时间只关注当前 session 的任务",
  "",
  "## agent 初始化",
  "",
  "当你第一次在当前 session 中收到用户消息时：",
  "",
  "1. 从当前分支创建新分支: `git checkout -b agent/任务简述`",
  "2. 通知用户分支已创建",
  "",
  "## 日常工作",
  "",
  "1. 在 agent/* 分支上修改代码",
  "2. 阶段性完成时提交: `/oleader-commit \"做了什么事\"`",
  "3. 需要审查时创建 PR: `/oleader-pr`",
  "",
  "## git 操作指引",
  "",
  "- 始终在 `agent/*` 分支上工作",
  "- 提交前运行 lint 和测试",
  "- `git merge main` 同步最新代码",
  "- 冲突时通知用户解决",
  "",
  "## 完成工作",
  "",
  "1. 确认所有修改已提交",
  "2. 创建 PR",
  "3. 等待用户审查并合并",
].join("\n")

export default define({
  id: "openleader",
  setup: async (context) => {
    context.skill.transform((draft) => {
      draft.source({
        type: "embedded",
        skill: {
          name: "openleader",
          description: "多 agent 并行开发工作流。每个 session 是一个独立的 agent，拥有独立的 git 分支。",
          location: "skill/SKILL.md",
          content: SKILL_CONTENT,
        },
      })
    })

    context.command.transform((draft) => {
      const init = [
        "当前 session 需要初始化为 openleader agent。请执行以下操作：",
        "",
        "1. 查看当前 git 状态: `git status`",
        "2. 从主分支创建新分支: `git checkout -b agent/任务简述`",
        "3. 确认分支已创建: `git branch --show-current`",
        "4. 通知用户初始化完成",
        "",
        "注意：不要切换回 main 分支。始终在 agent/* 分支上工作。",
      ].join("\n")

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

      const status = [
        "查看当前 openleader agent 的状态。执行：",
        "",
        "1. `git branch --show-current` 查看当前分支",
        "2. `git status` 查看文件变更",
        "3. `git log --oneline -5` 查看最近提交",
        "4. 向用户汇报状态摘要",
      ].join("\n")

      draft.update("oleader-init", (cmd) => {
        cmd.template = init
        cmd.description = "初始化当前 session 为 openleader agent（创建 git 分支）"
      })

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
    })
  },
})
