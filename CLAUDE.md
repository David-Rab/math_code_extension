# Claude Panel — personal VS Code extension

A personal replacement for the official Claude Code VS Code extension: a conversation-first panel (subagent tabs, KaTeX math, status bar, rewind/fork, images, agent map, folder trust, sign-in). See README.md for features and layout.

## Start of every session: open bug reports

The panel's **Report a problem** button (⚑ in the panel's status bar) saves reports to `bug-reports/*.md` (git-ignored) with the user's description, versions, session state, warnings and the panel log. At the start of a session, list `bug-reports/` and read any report whose `Status:` is `open`. When one is fixed, change its line to `- **Status:** fixed in <commit>` and say so in your reply. The panel log is `%TEMP%/claude-panel.log`.

## The user

Reads only your text messages, never tool calls, diffs or command output: put every result, number and decision in your prose. Priorities: not laggy, not buggy, safe.

## Working here

- `npm run typecheck`, `npm test` (replay + unit + Markdown/LaTeX), `npm run build`, `node test/smoke.cjs` (loads the production bundle).
- Live checks against the real claude.exe (short Haiku sessions): `npm run e2e -- <scratch dir>`, `npm run trust-e2e -- <new scratch dir>`.
- Render benchmark / screenshots of real sessions: `test/harness.ts` + `test/cdp.mjs` (headless Chrome).
- Write files containing backslashes (regexes, `\n`, LaTeX) with the Write/Edit tools, not shell heredocs: the shell halves backslashes.
- Commit after each working step (git repo, branch `main`).

## Updating Claude Code

When the panel reports a new Claude Code release: read that version's section of the Claude Code CHANGELOG, `npm install @anthropic-ai/claude-agent-sdk@<version> --save-exact`, diff the message types in `sdk.d.ts` against the previous version and classify any new ones in `src/transcript.ts`, then typecheck, test, build, smoke, live e2e, commit. `npm run package` builds `claude-panel.vsix` (extension version follows the Claude Code patch number).

The panel's **Update now** button runs the mechanical part of this (SDK install, typecheck, tests, package, reinstall) but not the changelog review or the check for new message types, and it does not commit. If `git status` shows a changed SDK version in package.json, the user used it: do the review steps for that version, then commit.

## Safety rules

- Never offer or set `bypassPermissions`; the host refuses modes outside default/acceptEdits/plan/auto/dontAsk.
- The webview must not load remote content (CSP: no remote images; markdown `html: false`; KaTeX `trust: false`).
- Security-relevant settings are user-level only (`scope` application/machine), never from a folder's settings.
- Never write `~/.claude.json` or credentials; trust and sign-in go through Claude Code itself (workspaceTrust attestation, `claude auth login`).
- Anything that interpolates into a shell command must be validated first.
