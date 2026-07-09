# @openleader/plugin

OpenLeader — an OpenCode plugin for multi-agent parallel development with git worktree isolation.

## How it works

Each OpenCode session becomes an independent agent with its own isolated git worktree. Agents work in parallel without file conflicts, and changes are merged via pull requests.

```
home/
├── project/                      # main worktree (untouched)
└── .opencode-worktrees/
    └── <project-hash>/
        ├── <session-a>/          # agent A's isolated workspace
        └── <session-b>/          # agent B's isolated workspace
```

## What it does

- **Auto worktree on session create** — when a new session starts, OpenLeader creates a dedicated git worktree in `.opencode-worktrees/<project-hash>/<sessionID>`, checks out an `agent/<sessionID>` branch, and moves the session there
- **Auto git init** — if the project isn't a git repo yet, it initializes one automatically (with `.gitignore` to exclude `node_modules/`, `dist/`, `.env`)
- **Auto cleanup on session delete** — when a session is deleted, the corresponding worktree and branch are cleaned up
- **Synchronous setup** — worktree creation is synchronous with session creation, eliminating race conditions
- **Skill injection** — injects an `openleader` skill into the agent's context explaining the workflow rules
- **Commands** — `/oleader-commit`, `/oleader-pr`, `/oleader-status`

## Commands

| Command | Description |
|---------|-------------|
| `/oleader-commit` | Stage all changes, run lint/typecheck, and commit to the current agent branch |
| `/oleader-pr` | Push the branch and create a pull request |
| `/oleader-status` | Show the current branch, file changes, and recent commits |

## Architecture

The plugin is integrated directly into the core plugin layer at `packages/core/src/plugin/openleader.ts`. It uses `events.listen` (synchronous callback in the publish fiber) for session creation and `events.subscribe` (async) for cleanup, managing worktree lifecycle automatically. The `@openleader/plugin` external package is a thin stub for compatibility.
