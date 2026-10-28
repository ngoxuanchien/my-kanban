# Shared memory + agent orchestration — design spec

Date: 2026-10-28
Status: draft for the user to approve
Scope: design only. No code is part of this document.

Labels:

- **[user]**: the user decided this. Do not change it without asking.
- **[assistant's call, user may revise]**: decided while writing the spec.
- **[builder]**: left to the builder on purpose.

---

## 1. Intent

The user codes on one Mac with three agents: Claude Code, Codex and OpenCode. They keep hitting usage limits, and context does not carry between agents. They want:

- fewer tokens spent on the scarce plans, without losing the context that keeps work correct;
- one central memory that all three agents use;
- an orchestrator that picks the agent for each task, runs it, and checks the result.

This fork of Kanban already does most of the "run" and "check" parts. This design reuses that work and adds only the missing pieces.

### 1.1 Evidence (measured 2026-10-28 from local logs)

| Agent | Plan | Measured usage | Source |
|---|---|---|---|
| Claude Code | **Claude Pro**, often at the limit **[user]** | 75 sessions in my-kanban worktrees, 4,705 model calls: 585 M cache-read, 17.9 M cache-write, 3.5 M output tokens | `~/.claude/projects/*my-kanban*/*.jsonl`, `message.usage` |
| Codex | **ChatGPT Free** **[user]** | 39 sessions, 35.7 M tokens (95 % cached) | `~/.codex/sessions/**/*.jsonl`, last `token_count` event |
| OpenCode | free model `big-pickle` (OpenCode Zen) | 2,111 calls, ~153 M tokens, mostly cache | `~/.local/share/opencode/opencode.db`, table `message` |

What the numbers mean:

- **Claude's base context is heavy.** The first call of a session already carries ~62 k tokens (median; min 43 k, max 80 k). The average is ~87 k per call. So ~70 % of each call is fixed overhead: system prompt, 19 enabled plugins' skill lists, MCP tool schemas, `CLAUDE.md`/`AGENTS.md`.
- **Cost = base context × number of calls.** The most expensive sessions are long Claude implementation sessions (100–400 calls; one OpenCode-integration session used 37 M tokens). Re-reading files is not the main cost: only 47 `Read` calls in total against 2,534 `Bash` calls.
- **OpenCode quality problem.** In the most re-prompted OpenCode session (`Dev-nest`, 65 user messages) the user repeated the same request 3–4 times and found bugs by hand that the agent had reported as done. The cause is a weak model plus no self-check, not missing memory.

Conclusion: the biggest token saving is to keep implementation work off Claude. Shared memory mainly protects context quality when weaker agents do the work.

## 2. Goals, non-goals, anti-goals

### Goals

- G1. Implementation tasks run on **OpenCode and Codex, split evenly**, so the user can see their limits and quality on the board. **[user]** Claude plans and handles escalations.
- G2. Every implementation task is checked by **cross review**: Codex reviews OpenCode tasks, and OpenCode reviews Codex tasks. **[user]**
- G3. **One central memory server**, Basic Memory, used by Claude Code and OpenCode. **[user]** It stores its notes as the existing `contexte/` markdown files. Codex does not connect to it (see 4.2). **[user]** Codex gets context through the task prompt (G4).
- G4. Weak agents do not have to remember to search memory. The planner (Claude) copies the context each task needs into the task prompt. **[assistant's call, user may revise]**

### Non-goals

- Disabling or trimming Claude plugins or skills. **[user]**
- A metrics report or metrics script. **[user]** The user judges the agents from the board: the card's agent, its review rounds, and whether it ended in Done or Needs your review.
- An automatic model router. v1 picks agents by alternation (see 4.3).
- Automatic fallback when an agent runs out of quota. The task fails into the existing **Needs your review** column.
- Cross-project memory. v1 has one Basic Memory project, `my-kanban`. Basic Memory supports more projects later without changes to this design.
- Basic Memory Cloud, or anything that leaves the machine.

### Anti-goals (count as failure even if it "works")

- AG1. Task quality drops because a weak agent did not look up context it needed. G4 exists to prevent this.
- AG2. Memory notes are lost or overwritten. Notes must stay plain, human-readable markdown in `contexte/`, which the user can read and edit.
- AG3. A secret ends up in memory or in a config file in the repo.
- AG4. Agent config outside the repo (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/Library/LaunchAgents`) is changed without the user approving that specific change.
- AG5. Claude usage goes **up** because of this work. For example, Claude ends up reviewing every task, or memory tool schemas add more tokens than they save.

## 3. What exists today (grounding)

- **Task isolation.** Each Kanban task runs in its own worktree at `~/.cline/worktrees/<taskId>/<repoLabel>` (`src/workspace/task-worktree.ts:118-133`). Every `.gitignore`-ignored path in the main checkout is symlinked into the worktree (`src/workspace/task-worktree.ts:273-277`). This is how `contexte/`, `.env`, `CLAUDE.local.md` and `.claude/settings.local.json` reach every task.
- **Per-task agent choice.** `kanban task create|update --agent-id <id>` (`src/commands/task.ts:1097`, `:1163`). The agent ids include `claude`, `codex` and `opencode`.
- **Agent review.** Already implemented (`src/agent-review/`, spec `docs/superpowers/specs/2026-10-28-agent-review-design.md`). The reviewer runs tests, checks the app runs, and compares the result with the prompt. It allows up to 3 fix rounds, then sends the task to **Needs your review**.
  - The reviewer is chosen by the global setting `reviewerAgent`: `"same_as_task"` or a fixed `RuntimeAgentId` (`src/core/api-contract.ts:1032`, resolved at `src/agent-review/agent-review-service.ts:572-573`).
  - The UI for it is in `web-ui/src/components/runtime-settings-dialog.tsx`.
- **Reviewer launch.** A Claude reviewer runs with `--strict-mcp-config` and an empty MCP config (`src/agent-review/reviewer-runner.ts:74-90`), so it loads no MCP servers. Codex reviewers use `codex exec`, and OpenCode reviewers use `opencode run --standalone` (`:98-107`).
- **Agent configs on this Mac.**
  - Claude: 19 plugins enabled in `~/.claude/settings.json`, and no user MCP servers.
  - Codex: `~/.codex/config.toml` has one MCP server (`node_repl`).
  - OpenCode: `~/.config/opencode/opencode.jsonc` has `playwright`, `context7` and `gh_grep` MCP servers.
  - `uv`/`uvx` are installed at `/opt/homebrew/bin`.

## 4. Design

### 4.1 Roles

```
            ┌───────────── Claude Code (planner, escalations) ─────────────┐
            │ brainstorm → spec → plan → create Kanban tasks (--agent-id)  │
            │ copies the needed memory into each task prompt               │
            └──────────────┬──────────────────────────────┬────────────────┘
                           │ alternate                     │ alternate
                    ┌──────▼──────┐                 ┌──────▼──────┐
                    │  OpenCode   │                 │    Codex    │   implement in own worktree
                    └──────┬──────┘                 └──────┬──────┘
                           │ reviewed by Codex             │ reviewed by OpenCode
                           ▼                               ▼
                 Kanban agent review (tests, app check, prompt check, ≤3 fix rounds)
                           │ pass → commit → Done        │ fail ×4 / cannot_verify / quota
                           ▼                             ▼
                          Done                     Needs your review → Claude/user
            all three agents read/write ◄── Basic Memory server (127.0.0.1:8765/mcp) ──► contexte/*.md
```

### 4.2 Memory: one Basic Memory server

The choice of tool is **[user]**. The details below are **[assistant's call, user may revise]**.

- **One process, HTTP transport.** `basic-memory mcp --transport streamable-http --host 127.0.0.1 --port 8765 --project my-kanban`. One server means one writer to Basic Memory's SQLite index, so agents running in parallel cannot corrupt it. The HTTP transport always routes locally (Basic Memory forces `BASIC_MEMORY_FORCE_LOCAL=true` for HTTP/SSE; see `src/basic_memory/cli/commands/mcp.py` upstream).
- **Kept running by launchd.** A user LaunchAgent (`~/Library/LaunchAgents/local.basic-memory.my-kanban.plist`) with `RunAtLoad` and `KeepAlive`. Logs go to `~/Library/Logs/basic-memory.log`. This file is outside the repo and needs the user's approval (AG4).
- **Pinned version.** Install with `uv tool install basic-memory==<version>`, pinned to the latest release that is at least two weeks old on the install day. Record the version in `contexte/memory-orchestrator.md`. **[builder]** picks the exact version.
- **Storage = existing `contexte/`.** Basic Memory project `my-kanban` → `/Users/xuanchien/Project/claude-app/my-kanban/contexte`, the main checkout, which every worktree symlinks. Notes stay plain markdown, one topic per file (the existing rule). Nothing needs migrating.
  - **Risk:** Basic Memory may add frontmatter (`title`, `permalink`) to existing files when it indexes them. That is acceptable, because the files stay readable. It is checked once on a copy before the server is pointed at the real folder (rollout R2).
- **Client registration.** Same URL everywhere: `http://127.0.0.1:8765/mcp`.

| Agent | Where | In git? | Approval |
|---|---|---|---|
| Claude Code | `.mcp.json` at repo root, plus `"enabledMcpjsonServers": ["basic-memory"]` in `.claude/settings.local.json` | No. `.mcp.json` is added to `.gitignore`, so Kanban symlinks it into every worktree | Repo-local, no extra approval |
| OpenCode | `opencode.json` at repo root (project config, merged over the global config) | No. Added to `.gitignore`, symlinked into worktrees | Repo-local |
| Codex | **Not registered.** **[user]** A global `~/.codex/config.toml` entry would load the tools in every Codex session in every repo, cost tokens on the small Free quota, and send notes from other repos into my-kanban's `contexte/`. Codex gets its context from the task prompt (4.4) | — | — |

- **Reviewers do not use memory.** The Claude reviewer already runs with `--strict-mcp-config`. The Codex reviewer has no memory config. The OpenCode reviewer will load the tools from the project `opencode.json`. The schema cost of that is accepted in v1 (OpenCode's model is free). Its prompt does not ask it to use memory. **[assistant's call, user may revise]**
- **Token budget for memory.** The Basic Memory tool schemas add a fixed cost to every call of every session that loads them. R5 compares the first-call context of a fresh Claude session before and after registration, using the method in 1.1. If it grows by more than ~5 k tokens, follow-up options are to restrict the tool set or to register memory only for Codex and OpenCode. That decision belongs to the user, because of AG5.

### 4.3 Picking the agent

The even split is **[user]**. The mechanics are **[assistant's call]**.

- When Claude turns a plan into Kanban tasks, it gives each implementation task an explicit `--agent-id`, alternating `opencode` and `codex` in plan order. The plan file records the assignment.
- Claude is never an implementer unless the user asks (existing rule in `CLAUDE.local.md`).
- No router code. The user changes the split by hand if the board shows one agent doing clearly worse.

### 4.4 Task prompt template (context injection, G4) **[assistant's call, user may revise]**

The planner fills this for every task. It is the main defence against the OpenCode failure mode in 1.1 (repeated requests, unverified "done").

```
## Goal
<one sentence>

## Context you need (copied from memory / plan — do not search for it)
- <decision or convention, with file path:line>
- ...

## Files you may change
- <exact paths>. Do not touch any other file.

## Acceptance criteria (the reviewer checks exactly these)
1. <observable behaviour or command> → <expected result>
2. `npm run typecheck` passes; `npm run test:fast` passes; `npm run lint` passes.

## Out of scope
- <things not to do>

## When done
Run every acceptance command yourself and paste the output in your last message.
If you made a decision others need later, record it with the memory tool in contexte/<topic>.md.
```

The template lives in `docs/agents/task-prompt-template.md`, and `CLAUDE.md` points to it in one line. Only the planner (Claude) needs it, so it is not added to `AGENTS.md`, which every agent loads on every call.

### 4.5 Cross review **[user]**

- Add one value to the reviewer setting: `reviewerAgent: "same_as_task" | "cross" | RuntimeAgentId`.
- `"cross"` resolves per task:
  - task agent `opencode` → reviewer `codex`;
  - task agent `codex` → reviewer `opencode`;
  - any other task agent → same as task (unchanged behaviour).
- If the cross reviewer is not installed or is out of quota, the existing rules apply: the reviewer fails or times out, and the task goes to Needs your review. No silent fallback to Claude, because that would break AG5.
- Settings UI: add a **Cross (Codex ↔ OpenCode)** option to the existing reviewer selector.
- The user sets `reviewerAgent = "cross"` once rollout is done.

### 4.6 Memory usage rules for all agents **[assistant's call, user may revise]**

These are short and go in `AGENTS.md`. They apply to **implementing agents and to Claude when planning**. Reviewers are told nothing about memory. **[assistant's call, user may revise]**

- Memory lives in the Basic Memory project `my-kanban`, i.e. the files in `contexte/`.
- Before deciding something non-obvious, search memory for the topic. (Codex has no memory tool: it reads `contexte/` files only if the task prompt points to one.)
- Record durable decisions and findings as a note, one topic per note. Update or append to an existing note rather than creating a duplicate. Never put secrets in a note.
- If the memory server is unreachable, read and write the files in `contexte/` directly. Do not stop the task because of it.

### 4.7 Inside Kanban vs outside

| Piece | Where | Why |
|---|---|---|
| Run task in worktree, review loop, commit, Done | Kanban (exists) | Already built and tested |
| `reviewerAgent: "cross"` | Kanban (`src/`, `web-ui/`) | It is review logic; small change |
| Agent alternation | Planner behaviour + `--agent-id` (exists) | No code needed |
| Task prompt template | `docs/agents/` (repo docs) | Used by the planner only |
| Memory server | External: Basic Memory + launchd | Off-the-shelf; shared by agents outside Kanban too |
| Memory client config | Repo-local, gitignored files (`.mcp.json`, `opencode.json`, `.claude/settings.local.json`). Codex: none | Symlinked into every worktree; no global agent config changes |

## 5. File structure after rollout

```
my-kanban/                                  (main checkout)
├── .gitignore                    + /.mcp.json, /opencode.json            [git]
├── .mcp.json                     basic-memory → http://127.0.0.1:8765/mcp [local]
├── opencode.json                 mcp.basic-memory (remote)                [local]
├── .claude/settings.local.json   + enabledMcpjsonServers                  [local]
├── AGENTS.md                     + "Shared memory" section                [git]
├── CLAUDE.md                     + one line → task prompt template        [git]
├── MAP.md                        + new files                              [git]
├── docs/agents/task-prompt-template.md                                    [git]
├── docs/superpowers/specs/2026-10-28-memory-orchestrator-design.md        [git]
├── docs/superpowers/plans/2026-10-28-memory-orchestrator.md               [git]
├── src/core/api-contract.ts      + "cross" in reviewer setting            [git]
├── src/agent-review/…            + cross resolution                       [git]
├── web-ui/src/components/runtime-settings-dialog.tsx  + Cross option      [git]
└── contexte/                     = Basic Memory project "my-kanban"       [local]
    └── memory-orchestrator.md    decisions for this design

~/Library/LaunchAgents/local.basic-memory.my-kanban.plist   (user-approved)
```

## 6. Configuration (reference; exact keys are checked against the installed versions)

`.mcp.json` (Claude Code, project scope):

```json
{ "mcpServers": { "basic-memory": { "type": "http", "url": "http://127.0.0.1:8765/mcp" } } }
```

`opencode.json` (OpenCode, project scope):

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "basic-memory": { "type": "remote", "url": "http://127.0.0.1:8765/mcp", "enabled": true } } }
```

LaunchAgent `ProgramArguments`: `<uv tool bin>/basic-memory mcp --transport streamable-http --host 127.0.0.1 --port 8765 --project my-kanban`.

Kanban global config: `reviewerAgent: "cross"` (set in Settings after the feature ships).

No secrets are involved. The server listens on loopback only and has no auth, which is acceptable on a single-user Mac.

## 7. Rollout

| Step | What | Verify |
|---|---|---|
| R1 | Ship code and docs tasks: cross reviewer, AGENTS/template docs, `.gitignore` | typecheck, tests, lint green; review passed |
| R2 | Install pinned Basic Memory. Index a **copy** of `contexte/` and check what it changes in the files | `diff -r` between copy and original shows only frontmatter, or nothing. **Any other change (renamed, deleted or rewritten content, new files or folders, index files inside the folder): stop and ask the user before R3.** **[assistant's call]** |
| R3 | **(approval)** Add the `my-kanban` project at the real `contexte/` and install the LaunchAgent | MCP endpoint answers; server is back after logout/login |
| R4 | Create `.mcp.json`, `opencode.json` and the `.claude/settings.local.json` entry in the main checkout | In a fresh task worktree, Claude and OpenCode list the basic-memory tools and find a known note by search |
| R5 | Compare the first-call context of a fresh Claude session before and after memory registration | Increase ≤ ~5 k tokens, or bring the number to the user (AG5) |
| R6 | Pilot: the implementation tasks of this plan are themselves the pilot (alternating OpenCode/Codex, using the template). After the cross-review task is merged, set `reviewerAgent = "cross"` for the remaining tasks and future work **[assistant's call]** | Every task reaches Done or Needs your review; none hangs |

## 8. Risks

- **Codex Free quota.** Codex does half the implementation **and** half the reviews, and the Free tier is small. Expect quota failures early. They show up as Needs your review. If they dominate, the user may move reviews of OpenCode tasks to another agent. That is a settings change, not code.
- **`big-pickle` as a reviewer** may pass weak Codex work. Mitigations: the strict acceptance criteria in the template, and the user spot-checking during the pilot.
- **Basic Memory changing note files** (R2 checks this).
- **Concurrent edits to the same note** from parallel tasks. One server serializes the writes, but two agents can still overwrite each other's edits to the same topic. The one-topic-per-file and append rules reduce this.
- **Tool-schema overhead** (R5).

## 9. Left to the builder

- Exact Basic Memory version, and the exact config keys for the installed Claude Code and OpenCode versions.
- How `"cross"` resolves when the card has no explicit `agentId` (resolve the task agent first, exactly as `same_as_task` does, then cross-map).
- The wording of the `AGENTS.md` section and the template, within the content listed above.
- Tests for `"cross"` resolution, following the existing agent-review test style.
