# Wiring the orchestrator into the app

Status: built, experimental (2026-11-15). The engines
([orchestrator-engines.md](orchestrator-engines.md)) are wired into the app, and whole jobs
have run on a demo project. This says what the app already had to build on, what was decided,
how the work was divided, what the app can't do yet, and what has and hasn't been proven.

## What the host already has

Read from the code after the merge with ZCode v3.18.2. The rule is one path: where the host
already does something, the orchestrator uses it.

| Need                                                          | Use                                                                                                                                                       | Where                                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Start a conversation with a first message, a model and a mode | A `createSession` command with `firstInput { text, modelSelection, mode, planEnabled }`, sent with `IZCodeAgentService.sendConversationCommandV4`         | `packages/shared/src/zcode-protocol-v4/command.ts`, `packages/services/src/zcode-agent/zcodeAgent.ts`   |
| Start one in its own worktree                                 | `IManagedWorktreeService.startNewTask`: it makes the worktree, then the session, then sends the first message; `onDidSettleCreation` gives the session id | `packages/services/src/managed-worktree-tasks/`                                                         |
| Send a follow-up                                              | A `sendText` command                                                                                                                                      | same protocol file                                                                                      |
| Know a turn ended                                             | `IZCodeTaskService.onDynamicTaskTerminalOutcome(taskId)`; waiting on a person shows as `needs_attention` through `observeAppOperation`                    | `packages/services/src/session/zcodeTaskService.ts`, `packages/services/src/app-control/observation.ts` |
| Read what the agent answered                                  | `readSessionMessages`, keeping the assistant's text parts                                                                                                 | `zcodeAgent.ts`                                                                                         |
| Pick a connected CLI's model                                  | Find the provider whose endpoint is `cli://<agent>` in `IModelSelectionService.getView()`; the model id is the agent's own                                | `packages/services/src/connections/cliAgentProviders.ts`, `packages/shared/src/cli-agents.ts`           |
| A folder for the ledger                                       | `join(getAppConfigDir(), "orchestrator")`; the ledger hashes the project key itself                                                                       | `packages/services/src/paths.ts`                                                                        |
| The project's path and identity                               | `IProjectService.prepareSession({ projectId })`                                                                                                           | `packages/services/src/project/contract.ts`                                                             |

Four gaps the map found:

- **Managed worktrees are detached.** The host makes them with `git worktree add --detach`, so
  a run has no branch of its own. The worktrees engine needs one more function, `adopt`, that
  takes a worktree the host made and gives it the run's branch and marker.
- **A CLI agent's effort can't be set in a conversation.** The adapter passes only `--model`.
  The swarm already knows each CLI's flag (`packages/swarm/src/commands.ts`); the adapter should
  pass the same ones.
- **"Fix with agent" and "Use Plan X" only fill a draft.** Nothing in the fork starts a
  conversation by itself yet, so the orchestrator service is the first to do it.

- **Triage is slow through a CLI.** Measured on three messages with a fast model: 7 seconds
  each, all three routes right. That is fine for a job and too slow to put in front of every
  chat message, so Auto needs a quicker way to ask (a provider call, or a CLI kept warm) or a
  cheap first look that only asks the model when the message might be a job.

## Decisions

1. **Every run is a real conversation.** An executor or a reviewer is a conversation in the
   Stack that the person can open and type into. No headless runs.
2. **One way to make and remove worktrees: the host's.** The orchestrator asks `startNewTask`
   for the worktree and conversation, then `adopt` gives the run its branch
   (`xatlas/<taskId>/<agent>-<runId>`) and marker. Removal is the host's `removeWorktree`; the
   engine only answers whether it is safe (`canRemove`: the same checks `cleanUp` makes,
   without removing anything). Two things that check must learn first, or it would refuse every
   worktree the host made: files the host copied in from `.worktreeinclude` are copies and may
   go, and a dependency folder may go wherever it sits in the tree (`node_modules` in every
   package of a pnpm repository), which today's literal `disposable` paths can't say.
3. **One owner of the loop:** a host service, `packages/services/src/orchestrator`. It owns the
   ledger folder, calls the engines, and is the only thing that writes tasks and runs. The UI
   reads through it.
4. **Triage and the parliament ask models read-only** through the swarm's runners, as today.
   Only executors can change files, and only inside their worktree, in the conversation's
   mode.
5. **The reviewer is a new conversation in the same worktree in Plan mode.** Its findings come
   back as JSON, are written to the ledger, and are sent to the executor's conversation as its
   next message. Three rounds at most, then the task waits on the person.
6. **Local Git projects on the desktop first.** That is where the host's worktrees work. In a
   remote workspace, or a folder that is not a Git repository, the route is `direct` and the
   composer says why.
7. **Nothing merges, pushes or deploys.** This build ends at branches with reviewed commits.
   Opening pull requests and the release queue come after it.

## The team, as the parliament decided it

The brief: an outside advisor for when the models can't agree, a view on whether executors
should be specialists, and models that see each other's work, with the consensus keeping watch
over everyone, the reviewer included. Three models each proposed a structure for that team and
ranked the proposals. This section is the one that came first, with the gaps the others named
closed. The contracts are in
`packages/orchestrator/src/types.ts`; the service the UI talks to is
`packages/services/src/orchestrator/orchestrator.ts`, and what the loop asks of the app is
`host.ts` beside it.

**Understand first, then size it.** Before anything else, understand what the person means
and how much effort it needs: not everything needs the consensus. Triage is that step. One
call says what
it understood the person to want (shown to them before any agent is spent), lists the
questions it must ask when the message can be read in ways that lead to different work, and
sizes the message by two separate questions: is it big enough to divide, and is there a real
choice to make?

| The message is                   | Route          | Who plans (`planBy`) | What runs                                        |
| -------------------------------- | -------------- | -------------------- | ------------------------------------------------ |
| A question or a discussion       | `chat`         | —                    | An answer in the conversation                    |
| A small change                   | `direct`       | —                    | One executor                                     |
| Big, and the way is clear        | `orchestrated` | `one`                | One top model plans; division; executors; review |
| A real choice between approaches | `orchestrated` | `parliament`         | The parliament discusses; then the same          |

An unsure answer keeps the lighter way at every level. A job whose triage has questions waits
with them on its card (a "clarify" decision); the person answers with notes and starts it. The
one planner is the first parliament seat that can run.

**The parliament discusses, and does not vote.** Comparing finished plans came second to
debating the best way first: share ideas, knowledge and research, and build something better
together, without losing the original request. So the parliament runs the swarm's deliberation
([swarm.md](swarm.md)). The seats, shown to each other by letter, open with findings, sources
and approaches, discuss for two rounds, and agree when more than half of the weight stands on
one approach. Its heaviest backer writes the plan; the others amend it, say whether it still
does what was asked, and may block once; the writer revises once. The plan stands when more
than half of the weight has no block left, and any dissent is kept. Every prompt carries the
person's request word for word and keeps ideas beyond it apart, for the person: that section
is cut from what the divider, a fallback step and every executor's digest are given
(`splitBeyond`), and stays on the job for the person to read. A split goes
as two written positions to the outside advisors, and if they don't settle it, to the person.
The default seats are Mythos 5.2, Fable 5.2, Astra 6 and, last, Opus 5.5 at high effort, so
the single planner is still Mythos.

**Roles.** Triage, parliament and executor are as before, and only executors change files, in
their own worktree and inside what their step owns. The orchestrator is the host's loop, which
is code, not a model.

| Role     | Model tier                   | Reads                                | New                                        |
| -------- | ---------------------------- | ------------------------------------ | ------------------------------------------ |
| Reviewer | strong, another agent        | the executor's worktree              | carries lenses                             |
| Watcher  | fast, cheap                  | one run's last messages              | its first job                              |
| Chair    | frontier (a parliament seat) | the plan, the findings, every branch | new                                        |
| Advisors | frontier, hold no seat       | only what they are sent              | new: a panel asked in order, on by default |

**The board.** Agents post and never message each other. A post is a `note` entry in the
ledger; `to` names the step it is for. The loop builds each step a digest of the board, at most
`MAX_DIGEST_WORDS` words: the plan, what the step owns, one line per sibling step, and the
notes addressed to it, addressed to everyone, or written by the steps it depends on. The
executor gets the digest with its first message and again with each round of findings. A
sibling's branch can be read on demand: the digest names it.

**Steps and what they wait for.** A step's task id is `<jobId>.<key>`. A step can start when
every step it depends on has passed review. Its worktree starts from the first dependency's
reviewed commit and the other dependencies' reviewed commits are merged in; a merge that
conflicts stops the step and asks the person. Nothing is marked merged by this: a step that
passed review is `queued`, which here means "reviewed, waiting for the release queue".

**Review.** One reviewer conversation per step, read-only, in the executor's worktree; later
rounds go to the same conversation. Every review carries the "reuse" lens (does this repeat
code the project already has, and is any of it filler?), and the "design" lens when the step
changed UI files and the project has a `DESIGN.md`. The reviewer answers in JSON; each finding
gets an id, a severity and, when it repeats an earlier one, that finding's id. Findings go to
the executor as its next message, with the digest. A step passes when a round has no
"blocker". After `MAX_REVIEW_ROUNDS` rounds with blockers left, the chair is asked.

**Oversight.** Events only: no timers.

- **Code, when a turn ends** (`oversight.flagged`): an executor that changed files outside what
  its step owns is paused and the person is asked; a turn that ended with nothing committed is
  flagged and the executor reminded once; a reviewer that passed a diff of more than 400
  changed lines with no finding at all is flagged. The executor's commits must carry the run's
  trailers, and it is reminded once when they don't.
- **Watcher** (`watcher.advised`), at most twice per run, failed calls included: when a
  finding repeats in round two, and when a run stops to ask something. It posts a note or
  advises stopping or reassigning. A run that stopped to ask is always the person's to answer,
  in its conversation: the app queues any other message behind the question, so the watcher's
  advice is shown with the decision and nothing is sent to the run.
- **Chair** (`chair.ruled`), at most `MAX_CHAIR_RULINGS` rulings per job: when the last review
  round still has blockers, or when an executor disputes a finding (a line `DISPUTE <id>: why`
  in its reply). It rules fix, drop, reassign, or divide the unstarted steps again. With no
  rulings left, or when no seat can chair, the person decides.
- **Who chairs.** A parliament seat that proposes (not a votes-only seat), that did not write
  the winning plan, and whose agent is not the executor's. When no seat passes all three, a
  seat that did not write the winning plan and is a different model from the executor may
  chair, and the ruling says so. Otherwise nobody chairs.
- **The final read.** When every step has passed review, the chair reads every branch against
  the plan once. That is how the reviewer is reviewed. "pass" finishes the job; anything else
  is shown to the person, who sends it to the executors or accepts the work as it is.

**The outside advisors.** They are asked only when the parliament splits (in a contest run by hand: when the vote ends level at the top with at least two readable ballots), at most once each per job, and only when the project has them on. They
are on by default, in this order: Opus at high effort and Mythos 5.2 (fresh sessions of models that also hold seats: they took no part in the discussion and are sent only the two positions and what was said), both through Claude Code in safe mode with every tool turned off, in an empty folder, on the person's own sign-in, so they get none of the person's instructions, hooks or files; then `google/gemini-4-argon` through OpenRouter. The first two
are asked together, and Gemini only when they don't settle it (they disagree, or one fails or
gives no readable answer), so the one advisor that bills an API key is asked only then. Each
is sent the request, the two positions and what the members said about them, 32,000 characters at most, and no
repository. The level plans are ordered by the advisors' first choices, then by a Borda count;
points are not changed. If the advisors are off, all fail, or leave the top level, the choice
is the person's. `parliament.decided` records every advisor asked with its answer
(`advisors`), and the combined order (`advisorOrder`, seats, best first) when they settled it.
The OpenRouter key is read from `OPENROUTER_API_KEY` or the Mac's Keychain item
`openrouter-api-key` and never logged. Roles saved with the single advisor of before read as a
panel of one, on or off as saved.

**No specialist executors.** They would cut across the division by ownership, where each step
owns its files. The specialities are review lenses instead.

**Not built:** agents messaging each other directly, timers, specialist executors, and a model
in the orchestrator's seat.

**Direct messages.** In this build "chat" and "direct" go on in the conversation they were
typed in, as the composer sends them today, and the triage is recorded. Review for direct jobs
comes later.

**Effort.** A CLI conversation's model id carries it: `opus+high`, `gpt-6.1-sol+max+fast`
(`cliAgentModelId` in `@zcode/shared/cli-agents`). The app registers the id on the agent's
provider with `ensureCliAgentModel`, and the CLI adapter reads the options back off the id.
The selection's `reasoningLevel` must be "disabled". Titles and commit messages run without
the options.

## How the build was divided

The orchestrator was built the way it works: steps that share no file ran side by side, each
with its own executor, and a different model reviewed them.

| Step             | Owns                                                                                                                                      | Waits for                     | Done when                                                                                                                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts`      | `packages/orchestrator/src/types.ts`, `packages/services/src/orchestrator/orchestrator.ts` and `host.ts`, the channel, the accessor field | —                             | Done: the contracts, their validation, the service interface and the host port are written and type-check                                                                                                                                                      |
| `adopt`          | `packages/orchestrator/src/worktrees`                                                                                                     | —                             | Done: a detached worktree gets the run's branch and marker; `canRemove` answers without removing, and lets copied-in files and dependency folders go                                                                                                           |
| `cli-effort`     | `apps/zcode-cli/packages/adapters/src/model/cli-agent`                                                                                    | —                             | Done: a conversation through Claude Code or Codex runs at the effort its model id asks for                                                                                                                                                                     |
| `advisor`        | `packages/swarm` (the vote, `openrouter.ts`)                                                                                              | —                             | Done: a level vote is named as level, and an outside model breaks it when one is set                                                                                                                                                                           |
| `intake`         | `packages/orchestrator/src/routing`                                                                                                       | `contracts`                   | Done: triage says what it understood, its questions, and whether one planner or the parliament plans                                                                                                                                                           |
| `deliberate`     | `packages/swarm` (`runDeliberation`)                                                                                                      | —                             | Done: the swarm can discuss approaches first and write one plan together, falling back to a vote when the members can't agree                                                                                                                                  |
| `board`          | `packages/orchestrator/src/board`                                                                                                         | `contracts`                   | Done: a step's digest is built from the ledger within the word limit, and the steps that can start are named with the commits their worktrees start from                                                                                                       |
| `oversight`      | `packages/orchestrator/src/oversight`                                                                                                     | `contracts`                   | Done: the turn-end checks, the review prompt with lenses and its reader, the chair's pick, prompts and reader, and the watcher's prompt and reader exist as pure functions                                                                                     |
| `node-host`      | `packages/services/src/orchestrator/nodeHost.ts`, the registration in `node.ts`                                                           | `contracts`                   | Done: the host port is answered by the app's own services, and the service is registered and reachable from the UI                                                                                                                                             |
| `host-loop`      | `packages/services/src/orchestrator/orchestratorService.ts` and the files beside it, tests                                                | `adopt`, `board`, `oversight` | Done, and run in the app: with fakes for the host: a message is triaged; a big job runs the parliament, is divided, and starts every ready step at once; a finished step is reviewed and its findings sent back; oversight and the chair act on their triggers |
| `composer-route` | `packages/ui/src/app-shell/orchestrator`, the composer's send path                                                                        | `contracts`                   | Done, not reviewed by the independent reviewer: auto, Direct and Orchestrate sit beside the swarm button, and sending follows the choice                                                                                                                       |
| `stack-cards`    | `packages/ui/src/app-shell/taskStack`                                                                                                     | `contracts`                   | Done, not reviewed by the independent reviewer: a job shows as an Orchestrator card with its steps, who has each, the board, and what waits on the person                                                                                                      |
| `policy`         | `architecture-policy.yaml`, module files of the fork's packages                                                                           | every step above              | Not done: `pnpm architecture:check --changed` passes on the fork's new files                                                                                                                                                                                   |

Not in this build, and each needs a decision first:

- **The phone remote.** Upstream replaced the relay protocol with one that signs in to Z.ai.
  `packages/relay` still speaks the old one, so remote control is switched off. Either the
  relay learns the new protocol with a local identity, or the old transports come back as fork
  code.
- **Pull requests and the release queue** ([roadmap](pipeline-vision.md), phase 3).
- **A faster triage.** Through a CLI it takes about 7 seconds. `askOpenRouter` is a provider
  call that could answer in one, on the person's key.

## What the app can't do yet

Found while answering the loop's port with the app's own services. The loop is built so none
of these can lose work, but each is a limit a person will meet.

- **A restart interrupts a job.** The host can only wait on turns it sent since the app
  started. After a restart, a run that was working can't be watched, so its job waits on the
  person, who resumes or stops it. No step is started twice.
- **The reviewer reads and does not run.** It is in Plan mode: it reads the worktree and its
  diff (`git diff` and `git log` work for both CLIs), and may not be able to run the tests.
- **A reviewer's conversation uses a workaround.** The host has no call for "a conversation in
  a worktree that already exists". `nodeHost.ts` reserves the task row itself and sends the
  host's own worktree command. The right fix is a method on the managed worktree service.
- **Executors are confined, not sealed.** In the Autonomous mode Claude Code and Codex may
  write the worktree, their temp folders and the repository's git data (not its hooks or
  config), and may read anything. This is now what Autonomous means for every Claude Code and
  Codex conversation, not only for executors. Gemini CLI and OpenCode have no sandbox: there
  Autonomous is the same as Edit, so they can't run commands unattended. Network access inside
  the sandboxes was not checked. Codex prints a harmless lock error on each commit and can't
  delete a branch.
- **Two gaps in that confinement.** Outside a linked worktree, an unattended Codex edits and
  runs but can't commit: git needs the top of `.git` for that, beside the hooks, so it gets
  none of it. And a person's own Claude Code settings are merged with the ones sent: an allow
  list of theirs can widen what is writable.
- **Model ids with options are models.** `opus+high` is registered on the agent's provider
  the first time it is used. Whether the model picker lists such ids was not looked at.
- **Triage takes about 7 seconds** through a CLI, so the composer's default is Direct. Auto and
  Orchestrate are a click away.
- **Direct jobs are not reviewed yet.** They go on in their conversation as before.
- **Projects with several roots.** The Stack reads a project's first root and the composer
  sends its own folder, so a job started from a second root may be filed apart.
- **The swarm's own screens** show a discussion under the contest's three labels, put a plan
  badge on every member, and say "no model returned a readable vote" for a split that nobody
  settled.
- **Rough edges on screen.** The job's plan is shown as raw Markdown; the composer's notice
  names the Stack without linking to it; a waiting job's status line repeats the chair's whole
  text and is cut off on the card; a job the person accepted after the chair's objection still
  says it "passed the chair's final read"; two executors starting together can each add the
  same line to the repository's local exclude file (harmless).
- **Ownership is checked at the door.** A job's owner is checked on starts and sends, not on
  every ledger write, and the loop's bookkeeping (decisions, answers, owners, each run's start
  commit) is kept as notes whose `from` starts with `xatlas:` until the ledger gets kinds of
  its own for them.
- **A sitting costs more now.** Four top models with the default roles, three of them through Claude Code,
  and more turns each: about fifteen calls where it agrees, more when it splits.

## Proof

**A first real job ran end to end on 2026-11-15**, in the dev app, on a small throwaway
repository. The message, sent with Orchestrate: add a `formatCents` function with tests, and
separately a Usage section in the README.

| When | What happened                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0:00 | Triage (the route was the person's); the job appears                                            |
| 0:33 | One planner (Mythos 5.2) wrote the plan: no parliament, the way was clear                       |
| 1:06 | Divided into two steps that own different files                                                 |
| 1:07 | Two Opus 5.5 executors at high effort start at once, each in its own worktree and branch        |
| 1:33 | The first is done and its reviewer (GPT-6.1 Sol, max, fast) starts in the same worktree         |
| 1:55 | Review passed, no findings; the second step passed at 2:06                                      |
| 2:48 | The chair (Astra 6: not the planner, not the executors' agent) read both branches and passed it |

Each step ended as one commit on `xatlas/<task>/<agent>-<run>` carrying the run's four
trailers, touching only the files its step owned; the tests passed in the worktree and `main`
was untouched. The card and the detail view showed it as it happened.

**The parliament discussed a real question the new way.** Asked "how can this app be better
for the people who use it?" on this repository, Mythos 5.2, Fable 5.2 and Astra 6 put nine
approaches on the table. Mythos merged two of them in the first round, all three backed the
merge in the second, Mythos wrote the plan and the other two approved it: no vote, 9.5
minutes. They chose **step
results you can open**: a finished step shows the files and lines it changed and opens its
diff, and the Stack card says how many branches are ready.

**The four seats then sat under the discussion protocol**, on the same question, with no
vote: 12 minutes, 18 calls. Mythos 5.2, Fable 5.2, Astra 6 and Opus 5.5 opened with thirteen approaches and what
they had read in the code, answered each other by letter with file and line, and three of the
four
stood on a merge: **a job that waits on you shows its question on its Stack card, answerable
in one click, and a chip inside a conversation says how many jobs are waiting.** Fable wrote the
plan and took every amendment. Astra blocked: answering "Resume" from the card could approve
file changes the person can't see. Fable narrowed the plan to meet it, Astra still held a
narrower version of the concern, and the plan stands three of four with that dissent kept.
Ideas beyond the request (OS notifications, the phone) were listed apart. The first run, under
the earlier protocol with three seats, had chosen "step results you can open"; both are ready
to be built through the route.

**A second job ran on the fixed code**, after the review of the loop. Both steps passed
review, and then the chair's final read did what it is for: the plan had a third step,
"integrate the two commits on one branch and verify", that the division had rightly left out
(nothing here merges) and nobody had built. The chair said so, the job waited on the person
with two buttons, and "Accept the work as it is" from the card finished it. The planner is now
told not to plan a step that joins branches.

Still to prove:

1. **xatlas improves itself.** Send that plan through the route on this repository, so the
   steps are built in their own worktrees and reviewed.
2. **A second real project.** The same on another codebase, with a group of real fixes.
   Nothing is merged or deployed there.
3. The parts no real run has reached yet: findings and a second round, a dispute and the
   chair's ruling, a paused run, a restart in the middle, a level vote with the advisor (one
   real call to the advisor's model through OpenRouter answered in 2.6 seconds).

## Working on it

- Type-check in a worktree where the dev app is not running: the app's build rewrites
  `packages/desktop/out` and the type check then fails for reasons that have nothing to do
  with the change.
- Upstream retired the app's unit tests. xatlas keeps its own in the root `unit` project
  (`xatlasUnitTests` in `vitest.config.ts`); a new test file goes on that list.
- To try a job in the dev app: `pnpm dev:desktop:sandbox`, DevTools on `127.0.0.1:9229`. The
  sandbox keeps its projects in `~/.zcode-xatlas-dev/demo-projects` and each project's ledger
  in `~/.zcode-xatlas-dev/.zcode/v2/orchestrator/ledgers`, one line per entry, which is the
  quickest way to watch a job move.
