<p align="center">
  <img src="docs/logo.png" width="256" height="256" alt="MarginaliaPrime">
</p>

# MarginaliaPrime

A desktop ebook reader with Claude alongside, for reading technical books.

> _Marginalia (n.) — notes, comments, and annotations made in the margins of a book; from Latin marginalis, "of the margin."_

<p align="center">
  <img src="docs/screenshot-reader.png" alt="The reader showing an ebook chapter with the chat sidebar open">
</p>

<table>
  <tr>
    <td><img src="docs/screenshot-highlight-text.png" alt="Selecting a passage with the highlight and annotation toolbar"></td>
    <td><img src="docs/screenshot-highlight-chat.png" alt="Asking a question about a highlighted snippet and receiving an answer"></td>
  </tr>
</table>

## What it does

Reading a maths or computer science book means stopping every few paragraphs to ask a question.
Doing that with a chat window in another application means copying the passage, re-explaining where
you are, and fighting a PDF that mangles every formula on the way out.

Here the book is on the left and the conversation on the right. Select a passage, ask, and keep
reading. The model already knows which book you are in, where you are in it, and what you selected.

This is a fork of [eddmann/Marginalia](https://github.com/eddmann/Marginalia), itself a slimmed-down
fork of [Readest](https://github.com/readest/readest). What this fork changes is listed in
[NOUVEAUTES.md](NOUVEAUTES.md) (in French); the short version is below.

## Requirements

[Claude Code](https://claude.com/claude-code) installed and logged in: typing `claude` in a terminal
must work. That subscription is what answers your questions.

- **No API key.** The app runs the official `claude` CLI as a child process, and the CLI
  authenticates itself. Nothing reads a token, nothing calls the API directly.
- Questions therefore draw on your subscription quota, like any Claude Code session.
- If `claude` is not on the `PATH` — which happens when the app is launched from a desktop icon —
  set `MARGINALIA_CLAUDE_BIN` to its full path.

Linux and macOS. The engine is a child process, so nothing platform-specific is required beyond a
working Claude Code install.

## Features

Reading, inherited from Readest:

- EPUB, PDF, MOBI, AZW/AZW3, FB2, CBZ, TXT, Markdown
- Page and scroll mode
- Highlights, bookmarks, annotations
- Export annotations as Markdown
- Full-text search
- Dark, light and automatic theme
- Customisable fonts, margins and layout

Chat:

- Collapsible side panel; select text, click **Ask AI**, ask
- Reading position, selected passage and surrounding text sent with every question
- Chapter text sent once per conversation; for a PDF, a window of pages around you
- One conversation per book, resumed where you left it after closing the app
- Several conversations per book, switchable and deletable
- Claude Opus 5, Sonnet 5 and Haiku 4.5, chosen in two levels: backend, then model
- Optional web search for facts outside the book
- An **Inspect** panel showing exactly what goes to the model: the command line, the standing
  instructions, the next message verbatim, token usage and the raw event stream

## Getting started

```bash
make install                             # dependencies
cd app && pnpm tauri build --no-bundle   # release binary
./src-tauri/target/release/Marginalia
```

Import a book, open it, open the chat panel, select a passage.

> Build the binary with the Tauri CLI, not with `cargo build --release`: a plain cargo build embeds
> the frontend incorrectly and the app starts on a blank window with no error.

## Development

Requires Rust, Node.js 20+ and pnpm.

```
make install   # install all dependencies
make dev       # start the development app
make build     # build the production app and bundles
make lint      # eslint, tsgo, cargo fmt, clippy
make fmt       # format all code
make clean     # remove all build artifacts
```

Unit tests: `cd app && pnpm test`.

Two scripts help when the change has to be judged on the real app rather than on the type-checker:

- `scripts/perf-run.sh <label> <binary> [book] [seconds]` — prints the startup and book-opening
  timings collected by the `[perf]` marks.
- `scripts/smoke-chat.sh <book-hash> "<step>|<step>"` — replays a whole chat scenario against the
  release binary, with no clicking. A step is a question, or one of `newconv`, `delete`,
  `book:<hash>`, `model:<id>`, `abort`, `wait:<ms>`. It uses the real subscription.

## Built with

- [Readest](https://github.com/readest/readest) — the ebook reader this descends from
- [foliate-js](https://github.com/johnfactotum/foliate-js) — book rendering
- [pdf.js](https://github.com/mozilla/pdf.js) — PDF rendering
- [Tauri v2](https://tauri.app) — native desktop runtime
- [Claude Code](https://claude.com/claude-code) — the engine behind the chat panel

## License

AGPL-3.0 — same as [Readest](https://github.com/readest/readest) and
[Marginalia](https://github.com/eddmann/Marginalia), from which this project is forked. A
distributed fork has to stay under the same licence.
