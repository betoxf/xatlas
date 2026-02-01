# Operador Roadmap

This file tracks product ideas and larger follow-ups for the dashboard extension.

## Near-term ideas
- Collapsible left panel (closed by default) with VS Code-style Explorer + Source Control views.
- Per-project mini terminal preview updates in the dashboard grid (live tail of output).
- Reliability improvements for embedded terminals (auto-reconnect, retries, clearer status states).
- Hide or auto-minimize the first terminal session by default (toggle per window or global).

## Quality and reliability
- Preserve terminal sessions on tab switches (avoid killing PTYs when changing tabs).
- Better handling of pty failures: backoff retries, actionable status, manual reconnect button.
- Improve resize/render stability when multiple floating windows are open.
- Keep lightweight output buffers for previews without memory growth.

## UX and workflow
- Shortcut icon per project to open full VS Code window (folder) while keeping the dashboard running.
- Quick file opener/search inside dashboard (open or preview file without leaving).
- Drag-and-drop files into terminal sessions (send path or open).
- Per-project notification rules (sound/badge on completion, prompt detection, errors).

## Longer-term explorations
- Embedded file editor preview in the dashboard (read-only or quick edits).
- Persisted window layout (positions/sizes) across sessions.
- Workspace grouping and tags for large multi-project dashboards.
- Custom theme presets for the dashboard UI.
