<p align="center">
  <picture>
    <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
    <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
  </picture>
</p>
<p align="center">OpenCode — OpenLeader 多 agent 并行开发插件。</p>

---

##  本分支的变更

基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) 上游 `dev` 分支，添加了 **OpenLeader** 插件。

### OpenLeader 插件

多 agent 并行开发工作流，基于 git worktree 实现文件隔离。

```
home/
├── project/                      # git 主工作树
└── .opencode-worktrees/
    └── <project-hash>/
        ├── <session-a>/          # agent A 的隔离工作区
        └── <session-b>/          # agent B 的隔离工作区
```

**核心特性：**

- 每个 OpenCode session 自动获得独立的 git worktree
- 每个 agent 在 `agent/<sessionID>` 分支上独立工作
- 文件修改互不干扰，通过 PR 合并回默认分支
- Session 创建时同步创建 worktree（无竞态条件）
- Session 删除时自动清理 worktree
- 命令：`/oleader-commit`、`/oleader-pr`、`/oleader-status`

详见 [packages/openleader](packages/openleader/)。

---

## 上游 OpenCode

本分支追踪上游 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的 `dev` 分支。上方未提及的功能与原版一致。
