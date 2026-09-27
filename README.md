# MathPanel (unofficial)

> **Unofficial personal project. Not affiliated with, endorsed by, or supported
> by Anthropic.** Claude and Claude Code are trademarks of Anthropic PBC.

An alternative, conversation-first VS Code panel for Claude Code. It runs
Claude Code through Anthropic's public Agent SDK (`@anthropic-ai/claude-agent-sdk`)
and adds a clean conversation view, a tab per subagent, and rendered math.

## Your account and Anthropic's terms

- Build it yourself and sign in with **your own** account, through Claude Code's
  own login (`claude auth login`, run by the panel in a terminal). The panel
  never sees, stores or forwards credentials, and does not offer, provide or
  share Claude access.
- Your use is governed by your own agreement with Anthropic (Consumer Terms for
  Free/Pro/Max plans, Commercial Terms for API keys). Subscription plans are
  meant for ordinary individual use; for anything beyond that, use an API key.
  Anthropic may restrict subscription use in third-party tools: use at your own
  risk.
- **Do not redistribute built `.vsix` files, and do not publish this to the VS
  Code Marketplace or Open VSX.** A build contains Anthropic's proprietary
  Claude Code binary and SDK, which this repository's license does not cover.
- Some features rely on undocumented or experimental SDK options
  (`workspaceTrust`, `enableRemoteControl`, `usage_EXPERIMENTAL_…`) that may
  change or stop working in a future Claude Code release.

## Features

- **Conversation first:** only your messages and Claude's replies; tool activity
  collapses to one line (hidden / summary / detailed).
- **Subagent tabs:** a tab per subagent with its task, replies and live status;
  a warning bar when a background tab needs you. **Agent map** (⌬, Ctrl+Shift+M):
  a tree of all agents with status, model, running time and actions.
- **Math:** KaTeX for `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and `align`-style
  environments; ∑ toggles to source. `\F \Q \C \E` built in, more via the
  `mathMacros` setting. Copy button keeps the LaTeX.
- **Status bar:** model, effort, permission mode, context %, cache %, 5-hour and
  7-day plan usage, remote control, Claude Code version, ⚑ report a problem.
- **Cards:** permission prompts (with the edit or file content and Claude Code's
  reason), Claude's questions, plan approval, sign-in, folder trust.
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

The **Auto** permission mode lets Claude Code's classifier approve many actions
without asking; it prompts much less than "Ask before edits".

## Safety

- The webview loads no remote content: images in replies render as links,
  Markdown raw HTML is off, KaTeX runs untrusted.
- Links in replies: web links open in the browser; network paths and other URI
  schemes are refused; files outside the project need confirmation.
- No program is started by bare name from a workspace folder; system tools are
  started by full path.
- Settings that choose the executable, permission mode or remote control are
  user-level only; a folder's `.vscode/settings.json` cannot set them. The panel
  never uses `bypassPermissions`.
- Folder trust and sign-in go through Claude Code itself; the panel never
  writes `~/.claude.json` or touches credentials. Trust covers the whole git
  repository containing the folder.
- Rewinding code and deleting sessions ask for confirmation first.

## Build, test, install

Windows only for now (the build bundles the win32-x64 Claude Code binary).

```sh
npm install
npm run typecheck
npm test                     # transcript replay, unit, Markdown/LaTeX
node test/smoke.cjs          # production bundle loads (after a build)
npm run e2e -- <dir>         # live session against claude.exe (Haiku)
npm run trust-e2e -- <dir>   # live folder-trust flow (fresh dir)
npm run package              # mathpanel.vsix, for your own machine only
code --install-extension mathpanel.vsix --force
```

Render benchmark on a stored session (needs Chrome):

```sh
npm run harness -- x y >/dev/null; BENCH=1 node .test/harness.mjs "<project dir>" <session id> "" .test/harness/b.html
node test/cdp.mjs .test/harness/b.html .test/harness/b.png
```

## Bug reports

⚑ in the panel saves a report to `bug-reports/` (git-ignored, stays on your
machine).

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

## License and third-party software

This repository's code is MIT-licensed (see [LICENSE](LICENSE)); that license
does not cover Anthropic's SDK or Claude Code. The panel uses, via npm:
[preact](https://github.com/preactjs/preact) (MIT),
[markdown-it](https://github.com/markdown-it/markdown-it) and its dependencies
(MIT; `entities` BSD-2-Clause), and [KaTeX](https://github.com/KaTeX/KaTeX)
including its fonts (MIT, Khan Academy and other contributors).
