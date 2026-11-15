# Security policy

xatlas runs coding agents on your machine, with the file, terminal and network access those
agents have. Security reports are handled privately first.

## Reporting a vulnerability

Don't open a public issue for a suspected vulnerability. Use
[GitHub's private vulnerability reporting](https://github.com/betoxf/xatlas/security/advisories/new).

Include the xatlas commit, your macOS version, the affected flow, reproduction steps, and what
you expected and observed. Never send access tokens, session keys, credential files or private
source code.

## Security boundaries

- xatlas has no project-operated backend and no xatlas account.
- Each CLI keeps its own sign-in. xatlas runs the CLI's status and login commands, and doesn't
  read or store its credentials.
- API keys you add are stored locally, as described in [NOTICE.md](NOTICE.md).
- The phone remote is switched off in this version. When it runs, it is served by your own Mac,
  over HTTPS with a certificate the phone apps pin.
- Agents act with your account's permissions. A CLI in full-access mode can do anything you can,
  so review what you run in untrusted projects.
- An orchestrator job runs its builders unattended. Claude Code and Codex are then confined by
  their own sandboxes: they can write their worktree, their temp folders and the repository's
  git data, and can read anything. That is a limit on writing, not a seal. With Gemini CLI and
  OpenCode there is no sandbox, so an unattended builder can edit but can't run commands. The known gaps are listed in
  [orchestrator-wiring.md](docs/xatlas/orchestrator-wiring.md#what-the-app-cant-do-yet).
- The orchestrator's own code and the release queue never merge, push or deploy. Builders are
  told to commit and nothing more, but they are agents with a shell, and whether their sandbox
  blocks the network has not been checked.
- UCU is a separate, optional project with its own [security
  notes](https://github.com/betoxf/universal-computer-use#before-you-use-it). Report its issues
  there.
- Vulnerabilities in ZCode itself belong [upstream](https://github.com/zai-org/ZCode) too.
