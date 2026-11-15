# Swarm: several models plan one task, by contest or by discussion

Status: first version (2026-10-20); weighted votes, fresh voters, effort, fast mode and saved
runs added for the parliament, then a discussion mode that never votes (2026-11-15). The
composer's swarm button runs the contest described first; the orchestrator's parliament runs
the [discussion](#deliberate-mode-a-discussion-that-never-votes). The spec is the Parliament part of
[orchestrator-engines.md](orchestrator-engines.md).

The honeycomb button in the composer turns a conversation into a swarm. While it's on,
sending the message asks the chosen models instead of the conversation's agent:

1. **Propose.** Each model plans the task on its own, in its own CLI with your sign-in,
   reading the project but changing nothing (Claude Code in plan mode, Codex read-only).
2. **Debate** (0–3 rounds). Each reads every plan and last round's critiques, critiques
   the others, answers points about its own plan and revises it. Plans are shown by
   letter only, so they judge the plan, not the model.
3. **Vote.** Each ranks the other plans with reasons. Fresh voters join here: they
   proposed nothing and saw none of the debate, and rank every plan. A weighted Borda count
   picks the winner.

The run shows live above the composer: one column per model, then the winner with the
voters' reasons and the score table. **Use Plan X** puts the task and the winning plan
into the composer, to send to the conversation's agent as usual.

- Members: any mix of Claude Code, Codex, OpenCode (including its free models) and Gemini
  CLI models; the popover lists which are installed and signed in. Defaults to Claude
  Code and Codex on their default models.
- A member that fails (signed out, timeout) is dropped with its reason; a swarm needs two
  members that propose. Fresh voters don't count towards the two, and one that fails or
  gives no readable ranking is reported and the run carries on.
- CLIs run with the login shell's PATH and the real home (the sandboxed dev app passes it
  as `XATLAS_GH_HOME`), so they behave as in the terminal.
- Code: engine and CLI runners in `packages/swarm`, host service
  `packages/services/src/swarm`, UI `packages/ui/src/app-shell/swarm`.

## Members

A `SwarmMember` can carry, besides its agent and model:

| Field       | Meaning                                                              | Default       |
| ----------- | -------------------------------------------------------------------- | ------------- |
| `weight`    | How much its vote counts; above 0 and at most 1000                   | 1             |
| `votesOnly` | A fresh voter: skips propose and debate, ranks every plan            | false         |
| `effort`    | `low`, `medium`, `high`, `xhigh` or `max`                            | the CLI's own |
| `fast`      | Ask for the model's fast mode; `false` is the same as leaving it out | the CLI's own |

The default parliament is Claude Code's `claude-mythos-5-2` and `fable`, Codex's
`gpt-6-astra`, and last Claude Code's `opus` at high effort.

## The count

A ballot gives the plan at `index` (0 is best) `weight × (plans − 1) × (k − index) / k`
points, where `k` is how many plans the voter may rank: plans − 1 for a member that wrote one
(it can't rank its own), every plan for a fresh voter. So everyone's first choice is worth
`weight × (plans − 1)`, and with every weight 1 and no fresh voter this is the plain Borda
count the swarm always had. Fresh voters give fractions, so points are kept to six decimals
and compared with a small tolerance.

Ties: points, then first places counted with weight (`SwarmScore.weightedFirstPlaces`), then
the earlier letter. `SwarmScore.firstPlaces` stays the plain count.

`tallyBallots` reads the weight from `SwarmBallot.weight` (absent is 1) and treats a voter
whose id is no plan's author as a fresh voter.

## Effort and fast mode

Checked on 2026-11-15 against Claude Code 2.1.325, Codex 0.169.0, OpenCode 1.18.21 and Gemini
CLI 0.66.0: the flags from each CLI's help, Codex's config keys from its own config file and
model catalog (details below). `memberCommand` builds the arguments; with neither set they
are exactly what they were before.

| CLI         | Effort                                       | Fast mode                    |
| ----------- | -------------------------------------------- | ---------------------------- |
| Claude Code | `--effort <level>`, all five levels as named | not supported (reported)     |
| Codex       | `-c model_reasoning_effort="<level>"`        | `-c service_tier="priority"` |
| OpenCode    | `--variant <level>`                          | not supported (reported)     |
| Gemini CLI  | not supported (reported)                     | not supported (reported)     |

- Claude Code's help lists `--effort <level> … (low, medium, high, xhigh, max)`. It has no
  fast-mode flag; its settings carry a `fastMode` key that `--settings` could set, but that
  isn't in the help and can't be checked in print mode without a model call, so it isn't sent.
- Codex takes any config key with `-c key=value`. The keys come from Codex's own config and
  model catalog (`codex debug models --bundled`), not from its help: the catalog's levels for
  `gpt-6-astra` are low, medium, high, xhigh, max and ultra, and its speed tier `priority` is
  named "Fast". Older models stop earlier (`gpt-5.5` at xhigh); what Codex does with a level
  the model lacks (refuse, or fall back) was not checked, since that takes a model call.
- Nothing is sent for an option that is left out, or for `fast: false`, so the CLI's own
  config decides. A Codex config with `service_tier = "priority"` or `model_reasoning_effort`
  set keeps those for every Codex member that doesn't say otherwise.
- OpenCode's variants are provider-specific (its help only gives "e.g., high, max, minimal");
  the level is sent as named, and what OpenCode does with a variant the model lacks was not
  checked.
- Where a CLI can't take an option, the run sends an `unsupported` event once per member and
  option before it starts (`{ type: "unsupported", memberId, option, detail }`), lists it in
  `SwarmResult.unsupported`, and the report shows it. Nothing is dropped silently.

## Deliberate mode: a discussion that never votes

With `--mode deliberate` (or `mode: "deliberate"` in `ISwarmService.start`) the members discuss
the request and reach one plan. Each keeps one letter for the whole run (A, B, …; fresh
readers after the proposers), and every prompt shows letters only.

**It stays on the request.** Every prompt carries the request word for word under its own
heading, with two rules: improve how it is built, not what was asked; an idea that goes beyond
or against the request is written apart, for the person, never into the approach or the
steps. The same rules are in the single planner's prompt, and the divider gives a "Beyond the
request" section no step.

**Research.** Members may search the web where their CLI allows it and must give a source, a
project path or a URL, which is shown as text and never opened. Checked on 2026-11-15 with
real runs: Claude Code searched and fetched a live page; Codex searched, and its pages came
from a cache. No flag was needed for either.

1. **Opening**, each alone, 250 words: what it found with sources, up to three approaches
   with trade-offs, questions for the others, its pick.
2. **Discussion** (`--rounds`, 0 to 3; the orchestrator runs 2), 250 words: each reads the
   discussion so far (newest first, 16,000 characters at most), answers the others by letter,
   adds what it knows, may offer a merge, and gives one stand: the approach it backs. The last
   round offers no merge, because only the member that offered it could back it.
3. **Agreement**: more than half of the proposers' weight on one approach. Its heaviest backer
   writes the plan in fixed sections: how it does what was asked; the approach and why; what
   was taken from whom; the steps with the files each owns and whether it waits; the risks; how
   to verify; and, apart from the steps, ideas beyond the request.
4. **Amendments**: every other member and every fresh reader says whether the plan still does
   what was asked (a "no" blocks), gives amendments, and at most one blocking concern. With any
   amendment or block the writer revises once, answering each by letter, and the members that
   blocked are asked once whether they still do.
5. The plan **stands** when more than half of the weight, the writer's included, has no block
   left; exactly half is not enough. Blocks that remain are kept as dissent in the result and
   the report.
6. A **split** (no majority, or a plan that does not stand) is not voted on. Two positions are
   written (the two leading approaches by their heaviest backers, or the revised plan and a
   counter-plan by the heaviest member still blocking) and go to the advisors with what each
   member said about them. If they settle it their choice is the plan; otherwise the choice is
   yours.

**What a member writes is data.** Everything quoted from a member into a later prompt is put
on one line in quotes, and a plan sits between `<plan>` tags with any line that looks like a
heading or a member's turn escaped, so no reply can pose as another voice or as the prompt
itself. A written plan, a revision, a position or a counter-plan counts only when it has the
plan's sections; a refusal or a note in its place is treated as nothing written. The advisors
get the whole request: if it can't fit in their packet beside enough of the two positions,
they are not asked and the choice is yours.

An unreadable reply says nothing: no stand, no block (but an unreadable "do you still block?"
leaves the block standing). A member that fails is dropped and its weight leaves the count.
Plans carry their writer's letter. `SwarmResult.deliberation` keeps the voices, every turn,
the amendments, the revision and the dissent; saved runs record the mode. Contest stays the
default for a swarm started by hand, and the swarm's own screens still show a discussion under
the contest's three labels (propose, debate, vote).

## A level vote or a split, and the outside advisors

In a contest, three members that each rank the other two can end in a circle: A over B, B over C, C over A,
3 points each. The count still puts one plan first, by first places and then by letter, but
that is no judgement. The result says so: `tied` lists the plans level at the top, and the
report tells the person the choice is theirs.

In a deliberation nobody votes, and the same thing is a split: no approach has a majority, or
the written plan does not stand. Two positions are written and sent in place of level plans,
with what the members said about them in place of ballots.

**Advisors** are extra heads for those two cases only. With `--advisor a,b,c`, each
`claude:<model>[+effort]` or `openrouter:<model>[+effort]` (for example
`--advisor claude:opus+high,claude:claude-mythos-5-2,openrouter:google/gemini-4-argon`), a
level vote with at least two readable ballots goes to them in order: the first two together, a
single advisor alone. Each gets the task, the level plans and how the members voted and why,
32,000 characters at most, and nothing else: no repository and no tools.

- **When asking stops.** When, among the answers that could be read, one level plan is the
  first choice of more than half and at least two answers were read (one, when no more than one
  advisor could answer). Until then the next advisor is asked, and one that fails or can't be
  read is recorded and the next asked in its place. So when the first two agree the third is
  never asked; when they disagree, or one fails, the third decides.
- **The count.** The level plans are ordered by the advisors' first choices, then by a Borda
  count of their rankings (a plan an advisor left out gets the average of the places it didn't
  fill). If that still leaves the top level, the vote stays level and the choice is yours: no
  letter and no advisor's place in the list breaks it. Nobody's points change.
- **A Claude Code advisor** runs `claude -p --safe-mode --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --model <model> [--effort <level>]` with the prompt on stdin, in an empty temporary folder removed afterwards, on your own sign-in. Safe mode leaves out your `CLAUDE.md` (whose imports could pull in any file), hooks, plugins and settings. Asked to read a file by its full path, it answers that it has no tools; asked for its instructions, it has none.
- **Codex, OpenCode and Gemini CLI can't be advisors:** even in an empty folder they keep
  their file tools and your home, so they could read the project.

The advisors are shown at most 20 ballots, with a note of how many were left out. The report
lists what each advisor ranked and which were not needed.

The OpenRouter key is read from `OPENROUTER_API_KEY`, or on a Mac from the Keychain item
`openrouter-api-key`. It is never an argument, a log line or part of an error. `--list` shows
whether a key was found. Each OpenRouter call bills that key and sends the level plans to OpenRouter and
the model's maker.

## Saved runs

`saveRun(dir, run)`, `loadRun(dir, id)` and `listRuns(dir)` keep one `<id>.json` per run in a
folder the caller gives, holding `version`, the time, status, task, members, events, and the
result when there is one. A save writes a temporary file in the same folder, flushes it and
renames it over the old one. `loadRun` gives `undefined` for a missing run and throws for a
file it can't read (cut off, or saved by a newer version); `listRuns` returns those in
`unreadable` instead of failing. `runSwarm` does no file IO: the caller saves. The app's
`swarmService` still keeps runs in memory for an hour.

## Command line

`pnpm --filter @zcode/swarm swarm --list` shows the agents. A run:

```sh
pnpm --filter @zcode/swarm swarm --task "Add dark mode" \
  --with claude:claude-mythos-5-2+max+w2,claude:fable+high,codex:gpt-6-astra+xhigh+fast \
  --cwd "$PWD" --save "$PWD/.swarm-runs" --out "$PWD/swarm.md"
```

Each member is `agent[:model][+option…]`. Options: an effort (`low`, `medium`, `high`,
`xhigh`, `max`), `fast`, `vote` (a fresh voter) and `w<number>` (weight, e.g. `w2`, `w0.5`).
`agent:model` alone works as before, and the whole spec is the member's id, so the same model
can sit twice, e.g. `claude:fable,claude:fable+vote`. Another example, with a fresh voter
from another family: `--with claude:fable+w2,codex:gpt-6-astra+high,gemini:gemini-2.5-pro+vote`.

pnpm runs the script inside `packages/swarm`, so pass `--cwd`, `--out` and `--save` as
absolute paths. From the repository root, `pnpm swarm …` is the same command.
