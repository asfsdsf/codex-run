<div align="center">

# Codex Run

Browse your Codex CLI conversation history in a beautiful web UI

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

- **Real-time streaming** - Watch conversations update live as Codex responds
- **Search** - Find sessions by prompt text or project name
- **Filter by project** - Focus on specific projects
- **Resume sessions** - Copy the resume command to continue any conversation in your terminal
- **Collapsible sidebar** - Maximize your viewing area
- **Dark mode** - Easy on the eyes
- **Clean UI** - Familiar chat interface with collapsible tool calls

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
  -d, --dir <path>     Codex directory (default: ~/.codex)
  --no-open            Do not open browser automatically
  -h, --help           Show help
```

## How It Works

Codex CLI stores conversation history in `~/.codex/`. This tool reads that data and presents it in a web interface with:

- **Session list** - All your conversations, sorted by recency
- **Project filter** - Focus on a specific project
- **Conversation view** - Full message history with tool calls
- **Session header** - Shows conversation title, project name, and timestamp
- **Resume command** - Copies the command to resume the conversation
- **Real-time updates** - SSE streaming for live conversations

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
