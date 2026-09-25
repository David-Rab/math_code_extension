# Claude Panel (personal)

A conversation-first VS Code panel for Claude Code. It runs the same engine as
the official extension (the Agent SDK driving a bundled `claude.exe`) and shows:

- only your messages and Claude's replies; tool activity collapses to one line
  (hidden / summary / detailed)
- a tab per subagent with its task, its replies and a live status; a warning
  bar when a background tab needs an answer from you
- LaTeX rendered with KaTeX (toggle with ∑ in the status bar)
- permission, question and plan-approval cards
- a status bar with model, effort, permission mode, context %, cache hit %,
  5-hour and 7-day plan usage, remote control, and the Claude Code version

Several panels can be open at once. Past sessions are listed in the Claude
Panel sidebar and in **Claude Panel: Open Previous Session…**. Open panels are
restored when VS Code restarts.

## Build, test, install

```sh
npm install
npm run typecheck
npm test                 # transcript replay + Markdown/LaTeX tests
npm run e2e -- <dir>     # real claude.exe session (uses Haiku; writes into <dir>)
npm run package          # production build + load check + claude-panel.vsix
code --install-extension claude-panel.vsix --force
```

Render benchmark against a stored session (needs Chrome):

```sh
npm run harness -- x y >/dev/null; BENCH=1 node .test/harness.mjs "<project dir>" <session id> "" .test/harness/b.html
node test/cdp.mjs .test/harness/b.html .test/harness/b.png
```

## Staying current with Claude Code

The panel bundles the `claude.exe` that matches its SDK version
(`dist/build-info.json`). About 15 s after startup it checks npm for a newer
`@anthropic-ai/claude-agent-sdk`. If there is one, it shows a notification
(**What changed?** opens the Claude Code changelog entries since the bundled
version; **Update now** reinstalls the SDK, runs the checks, rebuilds and
reinstalls the panel). Events from Claude Code that the panel does not
recognise appear as "Unsupported event" cards instead of being dropped.

## Layout

| Path | What |
|---|---|
| `src/extension.ts` | activation, commands, sessions sidebar, restore, update check |
| `src/session.ts` | one conversation: SDK query, permissions, status, webview messages |
| `src/transcript.ts` | SDK stream → threads (main + one per subagent) of display items |
| `src/warm.ts` | the pre-warmed spare `claude.exe` |
| `src/updates.ts` | npm version check, changelog, rebuild |
| `webview/` | the panel UI (Preact), Markdown + KaTeX renderer, styles |
| `test/` | replay, renderer, end-to-end and benchmark harnesses |
| `spike/` | the original feasibility probes and findings |
