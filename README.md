## npx kanban (Research Preview)

<p align="center">
  <img src="https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe" width="100%" />
</p>

A replacement for your IDE better suited for running many agents in parallel and reviewing diffs. Each task card gets its own terminal and worktree, all handled for you automatically. Enable auto-commit and link cards together to create dependency chains that complete large amounts of work autonomously.

> [!WARNING]
> Kanban is a research preview and uses experimental features of CLI agents like bypassing permissions and runtime hooks for more autonomy. We'd love your feedback in #kanban on our [discord](https://discord.gg/cline).

<div align="left">
<table>
<tbody>
<td align="center">
<a href="https://www.npmjs.com/package/kanban" target="_blank">NPM</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban" target="_blank">GitHub</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank">Feature Requests</a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank">Discord</a>
</td>
<td align="center">
<a href="https://x.com/cline" target="_blank">@cline</a>
</td>
</tbody>
</table>
</div>

### 1. Open kanban
```bash
# Run directly (no install required)
npx kanban

# Or install globally
npm i -g kanban
kanban
```
Run this from the root of any git repo. Kanban will detect your installed CLI agent and launch a local running webserver in your browser. No account or setup required, it works right out of the box.

### 2. Create tasks
Create a task card manually, or open the sidebar chat and ask your agent to break work down into tasks for you. Kanban injects board-management instructions into that session so you can simply ask it to add tasks, link tasks, or start work on your board.

### 3. Link and automate
<kbd>⌘</kbd> + click a card to link it to another task. When a card is completed and moved to trash, linked tasks auto-start. Combine with auto-commit for fully autonomous dependency chains: one task completes → commits → kicks off the next → repeat. It’s a pretty magical experience asking your agent to decompose a big task into subtasks that auto-commit - he’ll cleverly do it in a way that parallelizes for maximum efficiency and links tasks together for end-to-end autonomy.

### 4. Start tasks
Hit the play button on a card. Kanban creates an ephemeral worktree just for that task so agents work in parallel without merge conflicts. Under the hood, it also symlinks gitignored files like `node_modules` so you don't have to worry about slow `npm install`s for each copy of your project.

> [!NOTE]
> [Symlinks (symbolic links)](https://en.wikipedia.org/wiki/Symbolic_link) are special "shortcuts" pointing to another file or directory, allowing access to the target from a new location without duplicating data. They work great in this case since you typically don't modify gitignored files in day-to-day work, but for when you do then don't use Kanban.

As agents work, Kanban uses hooks to display the latest message or tool call on each card, so you can monitor hundreds of agents at a glance without opening each one.

### 5. Review changes
Click a card to view the agent's TUI and a diff of all the changes in that worktree. Kanban includes its own checkpointing system so you can also see a diff from the last messages you've sent. Click on lines to leave comments and send them back to the agent.

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar instead of remembering commands or asking your agent to do it.

### 6. Ship it
When the work looks good, hit **Commit** or **Open PR**. Kanban sends a dynamic prompt to the agent to convert the worktree into a commit on your base ref or a new PR branch, and work through any merge conflicts intelligently. Or skip review by enabling auto-commit / auto-PR and the agent ships as soon as it's done. Move the card to trash to clean up the worktree (you can always resume later since Kanban tracks the resume ID).

### 7. Keep track with git interface
Click the branch name in the navbar to open a full git interface to browse commit history, switch branches, fetch, pull, push, and visualize your git all without leaving Kanban. Keep track of everything your agents are doing across branches as work is completed.

## Fork features

This fork adds multi-agent orchestration on top of upstream Kanban. Design specs live in [`docs/superpowers/specs/`](./docs/superpowers/specs/).

### Agents and models
- **Task agents:** Codex, OpenCode, Antigravity (`agy`) and Claude Code. Pick one per task with `--agent-id`.
- **Model per task:** `--model haiku|sonnet|opus` for Claude, or a model id for Codex/OpenCode. `--reasoning-effort` sets Codex effort. A default Claude model lives in Settings.
- **Difficulty:** `--difficulty 1-5` scores a task. Settings holds a difficulty → model/effort table per agent. `kanban task models` prints it.

### Sidebar agent review
- Agent review is on by default for new tasks (`--agent-review-enabled`). When a task finishes, the sidebar agent reviews the worktree, runs the checks, and sends a fix list back with `kanban task send`.
- Up to 3 fix rounds per agent. A passed review commits the work and moves the card to Done (`kanban task trash --task-id <id> --review-passed --commit <hash>`).
- Review cards show who acts next: **Needs you** or **Sidebar**, plus the round (`Review n/3`; the cap grows by 3 per handoff).
- `--no-changes-expected` marks research/spike tasks that pass without a commit.

### Handoff and quota
- A task stuck after its review rounds is handed off along `codex → opencode → antigravity` (at most 2 handoffs, 3 review rounds per agent). `kanban task handoff --task-id <id> --message "<reason>"` does it by hand.
- Usage-limit messages (screen, OpenCode log, Antigravity session log) and Codex `model_not_found` trigger a handoff at once. A stuck agent first gets one `continue` nudge. When no agent is left the card shows **Out of quota** and retries later.
- Crashed or stopped sessions in Review restart with `kanban task start --task-id <id> --message "<fix list>"`.

### Task reports
- `kanban task report --state waiting --reason "<text>" --pid <pid>` keeps a long background job In Progress; Kanban wakes the agent when the process exits.
- `kanban task report --state blocked --question "<text>"` stores one owner question on the card and pauses all automation until the next run.
- Permission prompts keep the task In Progress with **Waiting for approval**.

### Board and history
- Linked backlog tasks start only when all their prerequisites are Done.
- The runtime moves cards In Progress ↔ Review from session state.
- Done cards open a read-only history: timeline, commit diff (or the saved patch), and the agent transcript.
- `kanban task list` prints a compact plain-text board; `kanban task show --task-id <id>` and `kanban task comment --message "<text>"` add detail and notes that later handoff/restart prompts include.
- Backlog tasks open in a large editor dialog for create and edit.
- A bottom status bar shows each agent's score (+1 pass, −1 fail, split per model) and task count.

### GitHub issue sync
Opt in per project in Settings. Each task mirrors to a GitHub issue through `gh`: a status label, one comment per column, the passing review, and the commit on Done. The prompt is never posted. Set issue fields with `--summary`, `--labels`, `--milestone`, `--assignee`.

### Desktop and terminal
- Terminal links (including OSC 8) open in the system browser; `file://` links inside the workspace open in VS Code.
- The top-bar **Open** button works from the desktop app.

## Desktop app (macOS)

Install the Apple Silicon desktop app from this checkout with one command:

```bash
npm run desktop:install
```

This builds Kanban and installs the unsigned app at `/Applications/Kanban.app`. Open it from Applications, then pin it to your Dock by right-clicking its Dock icon and choosing **Options → Keep in Dock**.

---

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
