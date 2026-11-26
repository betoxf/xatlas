# Roadmap: one app, many agents, a pipeline that ships

xatlas is built on ZCode, which already has the hardest parts: subagents with a model per
agent, a typed and resumable workflow engine, Claude-compatible plugins, skills and MCP
servers, hooks and scheduled automations. The roadmap turns those into a pipeline that any
agent can run.

## Target architecture

```
Surfaces       Stack (home) · conversation · summary · pipeline lane · phone
Orchestration  Pipeline runs (stages, gates) · Council and swarm (best-of-N + judge)
Router         role -> agent + model (+ effort), per project, with modes
Capabilities   one xatlas MCP server (git, pipeline, browser, computer use) + shared skills
Agents         built-in agent (API models) · CLI agents (Claude Code, Codex, Gemini, OpenCode)
```

## Agents

Done: Claude Code, Codex, Gemini CLI and OpenCode run conversations with your own sign-ins.
Approving a single command works with Claude Code and Codex. See [connect.md](connect.md).
Claude Code's and Codex's tool calls show as cards with their results.
Next: attachments, and tool cards for Gemini CLI and OpenCode.

## Router: roles, not one model

Done: the orchestrator has roles (triage, parliament, executor, reviewer, advisor), each with
an ordered list of agent, model and effort, stored per project. See
[orchestrator-wiring.md](orchestrator-wiring.md).

Next: a screen for them, modes for Automatic, Strongest, Fastest and Lowest cost, and the
remaining roles below.

| Role | Default tier |
|---|---|
| Prompt refiner, intent, titles, commit messages | Fast and cheap |
| Plan and consensus | Strong, from two model families |
| Implement | Strong, or a swarm |
| Test, QA, review | Strong, from a different family than the implementer |
| Fix feedback | Same as the implementer |
| Merge, deploy, sync | Deterministic scripts; a cheap model only explains |

## Prompt refiner

Done: triage reads a message before it becomes a job, says what it understood, asks what is
unclear and sizes the work, so small jobs skip the parliament.

Next: strong models need little prompting, so a cheap model adds context rather than rewriting
intent: it attaches the files, test commands and constraints the strong model would otherwise
spend turns finding. A small **Refined** chip shows the before and after, and can be undone.

## Pipeline

Done: a message sent with **Orchestrate** becomes a job: clarify, plan, divide into steps, a
worktree and branch per step, build, review with findings sent back, and the chair's final
read. It ends as reviewed branches. See [orchestrator-wiring.md](orchestrator-wiring.md).

Next:

- The stages after review: test, QA, draft PR, fix feedback, merge, deploy, validate.
- Gates: merge and deploy need approval, with per-run auto-merge and auto-deploy toggles.
- QA uses the built-in browser and the iOS simulator panel.
- The merge queue reuses the release queue's overlap checks.
- Review for messages sent with Direct.

## Council and swarm

Done: two ways for several models to plan one task. The swarm button in the composer runs a
contest: plan, debate, vote. The orchestrator's parliament runs a discussion: the models open
with what they found, answer each other and settle on one plan, with the dissent kept and no
vote; a split goes to outside advisors, then to you. See [swarm.md](swarm.md).

Next, best-of-N implementation: fan out candidates in their own worktrees, judge with evidence
first (tests, type check, lint, diff size), then a judge model from a different family than the
candidates. The winner merges, or a synthesis pass combines the best parts. A budget per run,
a cap on candidates and an early stop keep the cost bounded. In the UI a swarm run is a stack,
its candidates are cards, and the winner sits in front.

## Shared capabilities

- Done: one set of MCP servers, skills, instructions and memory for every agent. See
  [shared-agents.md](shared-agents.md).
- Done: computer use for every agent except Codex, which has its own, through
  [UCU](https://github.com/betoxf/universal-computer-use), if you want it.
- Next: one xatlas MCP server (projects, terminals, git, pipeline control) passed to every agent.

## Autonomy and remote

- A drive engine fed by repo signals (failing CI, flaky tests, outdated dependencies, open
  review comments) that proposes a card in the Stack, or runs a bounded, read-only
  investigation.
- Paused: the phone remote, served by your own Mac. It was built, and is switched off since
  the move to ZCode v3.18, which changed the relay protocol. See
  [mobile-and-releases.md](mobile-and-releases.md).

## Order

| Phase | Deliverable | State |
|---|---|---|
| 1. Spine | Tasks, runs with ids, a worktree per run, the ledger, the job card on the Stack | Built, experimental |
| 2. Routing and review | Triage, roles, the parliament for big jobs, the review loop | Built, experimental; checks and a pull request opened from a run are next |
| 3. Release queue | The queue, merge, deploy, a production check, which agent made each change | The queue reads and dry-runs; the rest is next |
| 4. Visual QA | A UI standard, screenshots, judges, a gate | Not started |
| 5. Swarm | Divide and assign, parallel work, the board, best-of-N | Built, experimental, except best-of-N |
| 6. Memory, ideas, tools | Project memory for all agents, suggested cards from repo signals, the xatlas MCP server | Not started |
| 7. Phone and releases | The remote on the new relay, push, store builds, installers | Paused |

Before any of it ships: continuous integration for this repository, and installers.
