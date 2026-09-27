# Claude Panel (personal)

A conversation-first VS Code panel for Claude Code. It runs the same engine as
the official extension (the Agent SDK driving a bundled `claude.exe`) and adds
what the official panel lacks for this user: a clean conversation view, a tab
per subagent, and rendered math.

## Features

- **Conversation first:** only your messages and Claude's replies; tool activity
  collapses to one line (hidden / summary / detailed).
- **Subagent tabs:** a tab per subagent with its task, replies and live status;
  a warning bar when a background tab needs you. **Agent map** (⌬, Ctrl+Shift+M):
  a tree of all agents with status, model, running time and actions.
- **Math:** KaTeX for `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and `align`-style
  environments; ∑ toggles to source. `\F \Q \C \E` built in, more via
  `claudePanel.mathMacros`. Copy button keeps the LaTeX.
- **Status bar:** model, effort, permission mode, context %, cache %, 5-hour and
  7-day plan usage, remote control, Claude Code version, ⚑ report a problem.
- **Cards:** permission prompts, Claude's questions, plan approval, sign-in,
  folder trust.
- **Progress list:** Claude's checklist above the message box, per tab.
- **Images:** paste or drop into the message box (scaled to 1568 px).
- **Rewind:** on your messages (↶): rewind code, fork the conversation from
  there, or both. Checkpointing is on for every session.
- **Sessions:** several panels at once; Sessions sidebar with rename, fork,
  delete; open panels come back with the window; a reopened session starts
  Claude Code only when you look at it.
- **Notifications:** sound and VS Code notification when Claude needs you (and
  when it finishes), only when you are not looking at that panel.
- **Fast start:** one pre-warmed Claude Code per window.
- **Staying current:** checks npm for new Claude Code releases (at startup and
  every 6 h), shows the changelog, and can rebuild. Unknown events from Claude
  Code appear as "Unsupported event" cards instead of being dropped.

## Safety

- The webview loads no remote content: images in replies render as links,
  Markdown raw HTML is off, KaTeX runs untrusted.
- Settings that choose the executable, permission mode or remote control are
  user-level only; a folder's `.vscode/settings.json` cannot set them. The panel
  never uses `bypassPermissions`.
- Folder trust and sign-in go through Claude Code itself; the panel never
  writes `~/.claude.json` or touches credentials.
- Rewinding code and deleting sessions ask for confirmation first.

## Build, test, install

```sh
npm install
npm run typecheck
npm test                     # transcript replay, unit, Markdown/LaTeX
node test/smoke.cjs          # production bundle loads (after a build)
npm run e2e -- <dir>         # live session against claude.exe (Haiku)
npm run trust-e2e -- <dir>   # live folder-trust flow (fresh dir)
npm run package              # claude-panel.vsix
code --install-extension claude-panel.vsix --force
```

Render benchmark on a stored session (needs Chrome):

```sh
npm run harness -- x y >/dev/null; BENCH=1 node .test/harness.mjs "<project dir>" <session id> "" .test/harness/b.html
node test/cdp.mjs .test/harness/b.html .test/harness/b.png
```

## Bug reports

⚑ in the panel saves a report to `bug-reports/` (git-ignored). A Claude session
in this project checks open reports first (see CLAUDE.md).

## Layout

| Path | What |
|---|---|
| `src/extension.ts` | activation, commands, sessions sidebar, restore, update checks |
| `src/session.ts` | one conversation: SDK query, permissions, rewind/fork, trust, sign-in, status |
| `src/transcript.ts` | SDK stream → threads (main + one per subagent), progress lists |
| `src/warm.ts` | the pre-warmed spare `claude.exe` |
| `src/auth.ts`, `src/trust.ts` | sign-in and folder trust via Claude Code |
| `src/notify.ts`, `src/report.ts`, `src/updates.ts` | notifications, problem reports, updates |
| `webview/` | the panel UI (Preact), Markdown + KaTeX renderer, styles |
| `test/` | replay, unit, renderer, e2e, trust e2e, benchmark harness |
| `spike/` | the original feasibility probes and findings |
