# Alfred Claude CLI

An Alfred 5 workflow for chatting with Claude using your **Claude subscription** — no API key required.

Uses the Claude Code CLI (`claude`) for auth, which logs in via your Claude Pro/Max subscription. Full chat UX inside Alfred with streaming responses and persistent conversation history.

## Features

- **Subscription auth** — uses `claude` CLI session, no Anthropic API key needed
- **Inline chat** — streaming responses rendered inside Alfred's text view
- **Multi-turn conversations** — full context via `--resume <session_id>` (server-side history)
- **Chat history** — browse and reload past conversations
- **Keyboard shortcuts** — ask, new chat, copy, stop generating

## Requirements

- [Alfred 5](https://www.alfredapp.com/) with Powerpack
- [Claude Code CLI](https://code.claude.com/) installed and logged in (`claude` on PATH)
- Claude Pro or Max subscription

## Installation

1. Download the latest `.alfredworkflow` from [Releases](../../releases)
2. Double-click to install in Alfred
3. Open Alfred Preferences → Workflows → Claude AI → `[x]` and configure:
   - **Claude CLI Path** — output of `which claude`
   - **Keyword** — default is `chatgpt`, change to `claude` or anything you prefer
   - **Working Directory** — directory the `claude` CLI runs in (where it picks up project files / `CLAUDE.md`). A leading `~` is expanded. Blank = Alfred's default cwd.
   - **Skip Permissions** — on by default; passes `--dangerously-skip-permissions` so Claude never pauses for tool-permission approval. Only keep enabled if you trust the Working Directory scope.
   - **Model** — Sonnet (recommended), Opus, or Haiku

To open your **current chat without typing the keyword**, assign a hotkey: in the workflow canvas, double-click the *Hotkey* node (top-left, labelled "Open current chat") and record your shortcut.

## Usage

Open Alfred → type your keyword → type your message → `↩`

| Key | Action |
|---|---|
| `↩` | Send message |
| `⌘↩` | Start new chat |
| `⌥↩` | Copy last answer |
| `⌃↩` | Copy full chat |
| `⇧↩` | Stop generating |

Also works via **Universal Action** (select text → `⌥⌘\` → Ask Claude) and **Fallback Search**.

## How it works

The workflow uses Alfred's `rerun: 0.1` loop to poll a growing stream file every 100ms. Each iteration, it parses NDJSON events from `claude --print --output-format stream-json --verbose`, extracts the latest cumulative text from `assistant` events, and updates the display. When the `result` event arrives, the `session_id` is saved for `--resume` on the next message — keeping conversation history server-side without embedding the full history in every prompt.

## Build from source

```bash
cd Workflow
zip -r ../claude-ai.alfredworkflow . -x "*.DS_Store"
open ../claude-ai.alfredworkflow
```

## Inspiration

- **[ammonhaggerty/alfred-claude](https://github.com/ammonhaggerty/alfred-claude)** — the base workflow this is forked from; modified the official Alfred ChatGPT workflow for Claude's API. This project replaces the API auth with CLI subscription auth and rewrites the streaming layer.
- **[truongvinht/alfred-claude-workflow](https://github.com/truongvinht/alfred-claude-workflow)** — showed the pattern of wrapping the Claude Code CLI inside an Alfred workflow for subscription-based auth.
- **[alfredapp/openai-workflow](https://github.com/alfredapp/openai-workflow)** — the original Alfred ChatGPT workflow that the whole chain descends from.
