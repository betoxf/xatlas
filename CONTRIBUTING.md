# Contributing to xatlas

Thank you for helping. The project favors small, reviewable changes.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Keep credentials, session tokens, account identifiers and private code out of issues, commits
  and screenshots.
- Follow [SECURITY.md](SECURITY.md) for security-sensitive reports.

## Development setup

Requires macOS 14 or later, Node.js 24 and pnpm 10.33 (see [mise.toml](mise.toml)).

```bash
pnpm bootstrap
pnpm dev:desktop:sandbox
```

`dev:desktop:sandbox` keeps app data out of `~/.zcode`, so it can't disturb an installed ZCode.

## Pull requests

- Read [AGENTS.md](AGENTS.md) for the architecture rules, and [DESIGN.md](DESIGN.md) before UI work.
  AGENTS.md is ZCode's, and xatlas differs from it in two places: xatlas keeps unit tests for its
  own packages, and `pnpm verify:pre-push` doesn't pass yet (see below).
- Update the matching note in [docs/xatlas](docs/xatlas) when behavior changes.
- Run `pnpm typecheck`, `pnpm lint` and the tests for what you touched
  (`npx vitest run --project unit` runs xatlas's own), and say in the pull request what you ran.
- The pre-push hook inherited from ZCode doesn't pass on this fork yet: its architecture check
  doesn't know xatlas's new files, and its last step compares against a `staging` branch this
  repository doesn't have. Until that is fixed, push with `git push --no-verify` after running
  the checks above yourself.
- Add en-US and zh-CN strings for anything people read.

By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
