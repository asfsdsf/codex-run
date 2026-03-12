<div align="center">

# Codex Run

Browse and interact with your Codex CLI conversations in a beautiful web UI

[![npm version](https://img.shields.io/npm/v/codex-run.svg)](https://www.npmjs.com/package/codex-run)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

<img src=".github/codex-run.gif" alt="Codex Run Demo" width="800" />

</div>

<br />

Run the project simply by executing

```bash
npx codex-run
```

The browser will open automatically at http://localhost:12001.

## Features

- **Live conversation viewer** - Stream Codex session updates in real time
- **Session search and project filter** - Quickly find the conversation you need
- **New session creation** - Start Codex threads directly from the UI with a project path
- **In-browser messaging** - Send follow-up prompts to an existing Codex thread
- **Plan mode workflow** - Toggle Plan mode and apply a proposed plan with one click

## Usage

Install globally via npm:

```bash
npm install -g codex-run
```

Then run it from any directory:

```bash
codex-run
```

The browser will open automatically at http://localhost:12001, showing all your Codex CLI conversations.

```bash
codex-run [options]

Options:
  -V, --version        Show version number
  -p, --port <number>  Port to listen on (default: 12001)
  -d, --dir <path>     Codex directory path (default: ~/.codex)
  --dev                Enable CORS for development (frontend at localhost:12000)
  --no-open            Do not open browser automatically
  -h, --help           Show help
```

## Codex Interaction (v0.3.0)

`codex-run` now supports interactive Codex workflows in addition to history browsing:

- Create a new thread by setting a project path and clicking **New Session**
- Send prompts from the bottom composer
- Toggle **Plan** mode for plan-first turns
- Pick model and reasoning effort before sending
- Stop current generation with **Stop**
- Respond to `request_user_input` option prompts in conversation view

Interactive mode uses `codex` under the hood. If your `codex` binary is not on `PATH`, set:

```bash
export CODEX_CLI_PATH="/absolute/path/to/codex"
```

## How It Works

Codex CLI stores conversation history in `~/.codex/`. This tool reads that data and presents it in a web interface with:

- **Session list** - All your conversations, sorted by recency
- **Project filter** - Focus on a specific project
- **Conversation view** - Full message history with tool calls
- **Session header** - Shows conversation title, project name, and timestamp
- **Resume command** - Copies the command to resume the conversation
- **Real-time updates** - SSE streaming for live conversations
- **Interactive Codex bridge** - Creates/sends/interrupts turns via `codex` app-server

## Requirements

- Node.js 20+
- Codex CLI installed and used at least once

## Development

```bash
# Clone the repo
git clone https://github.com/asfsdsf/codex-run.git
cd codex-run

# Install dependencies
pnpm install

# Start development servers
pnpm dev

# Build for production
pnpm build
```

## Acknowledgments

This project was originally based on [`claude-run`](https://github.com/kamranahmedse/claude-run) by Kamran Ahmed. Special thanks to the author for the great design and inspiration.

## License

MIT © Kamran Ahmed
