# cold-cache

A Claude Code mod that warns you when a conversation's prompt cache has gone cold, and offers a cheap way out.

Claude caches the conversation it has already read. Leave a session idle past the cache's lifetime (1 hour or 5 minutes, depending on your account) and the next message re-reads the entire context at full, uncached input price. On a long session that is the most expensive message you will send all day, and nothing in the UI tells you.

cold-cache puts a band above the prompt once the session has been idle past the threshold:

```
❄︎ Cache cold · next message re-reads 342k tokens uncached
  1: Handoff   2: Compact with Haiku   0: Dismiss
```

- **Handoff** (recommended for long sessions): Claude Haiku reads the conversation and writes a handoff document to your OS temp folder. The band then offers **Clear & continue** (copies a resume prompt, runs `/clear`, and fills the prompt box with it: the new session reads the handoff, opens with a **Where we were** recap for you, and proposes the next step) or **Copy prompt** (copy only, for picking up in another session or window).
- **Compact with Haiku**: compacts the conversation in place, with Haiku writing the summary instead of your main model.
- **Dismiss**: hides the band until the cache goes cold again. Sending any message also hides it.

It works in both the Claude Code CLI and the Claude desktop app's Code tab, from one codebase.

## Why Haiku

Compacting or summarising a cold session with your main model re-reads the whole context at that model's uncached rate, which is exactly the cost the warning is about. Haiku does the same reading for a fraction of the price. At list prices on the Claude API in October 2026:

| Reading 342k tokens of context | Cost   |
| ------------------------------ | ------ |
| Claude Opus 5.5, cache cold    | ~$1.37 |
| Claude Opus 5.5, cache warm    | ~$0.07 |
| Claude Haiku 5.5               | ~$0.17 |

Tool output is trimmed to its first 2,000 characters before Haiku sees it, which usually cuts the input by several times again.

Haiku calls go through your own Claude Code session's account and credentials, billed the same way as the rest of your usage.

## Install

You need Claude Code 2.1.295 or newer (the mod API is early access and may change between releases).

### Option 1: plugin marketplace (CLI)

In a Claude Code terminal session, type:

```
/plugin install cold-cache --marketplace mrkshw/cold-cache
```

Answer `y` to add the marketplace, then choose the **user** scope. Installed at user scope, it also loads in the desktop app's Code tab.

### Option 2: from a clone

Clone the repository somewhere permanent:

```powershell
git clone https://github.com/mrkshw/cold-cache.git C:\Tools\cold-cache
```

Try it for one session:

```powershell
claude --plugin-dir C:\Tools\cold-cache
```

To load it in every session, including ones the desktop app starts, add the folder to the `env` block of `~/.claude/settings.json` (create the block if it is missing):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Tools\\cold-cache"
  }
}
```

Several folders are separated by `;` on Windows and `:` on macOS and Linux. Restart the desktop app after changing it.

### Option 3: bundling it into a team toolkit

If you maintain your own marketplace, add an entry pointing at this repository:

```json
{
  "name": "cold-cache",
  "source": { "source": "github", "repo": "mrkshw/cold-cache" }
}
```

## Configuration

| Option             | Default | Meaning                                                                                                                                                   |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thresholdMinutes` | `60`    | Idle minutes after the last reply before the band appears. Match it to your prompt cache lifetime: `60` for a 1-hour cache, `5` for the 5-minute default. |

Change it in `/config` (the cold-cache row), or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "cold-cache": { "options": { "thresholdMinutes": 5 } }
  }
}
```

## Using it

- In the terminal, type `1`, `2` or `0` on its own and press Enter: while the band is showing, cold-cache runs that option and the message is never sent to the model. Alternatively, `ctrl+x tab` focuses the band, then the digit presses the button.
- In the desktop app, click the buttons.
- The band never appears while Claude is working, and is checked every 15 seconds while the session is idle.
- A resumed session counts its idle time from the last reply cold-cache saw, so a session you come back to the next day warns you straight away.

## What it sends, and where

- **Handoff and Compact** send the conversation to Claude Haiku through your own session's API client. Nothing goes to any third party, and nothing is sent until you press a button.
- **Handoff documents** are written to your OS temp folder (`%TEMP%` on Windows, `$TMPDIR` or `/tmp` elsewhere), never your project.
- Haiku is told to redact secrets and personal data from what it writes, but the input is your conversation as it stands; treat the handoff like the transcript.
- The only state kept between sessions is a timestamp of each session's last reply, pruned after seven days.

## How it works

- `turn.complete` records the time of each reply in the mod's store, keyed by session.
- A 15-second timer compares that time to the threshold and reads the context size from the session's usage, which is the figure the band shows.
- The band is an `AbovePrompt` render hook, drawn from the surface's own element table so the same tree renders in the terminal and the desktop app.
- **Compact** runs `/compact cold-cache:haiku`. A `session.compact` hook answers only compactions carrying that marker, so a `/compact` you type, and auto-compaction, are untouched. If the Haiku call fails the compaction is cancelled rather than falling back to your main model.

## Development

```powershell
claude plugin test .
```

```powershell
claude plugin validate .
```

Type-checking needs the API declarations Claude Code writes into `.claude-plugin/types/` the first time it loads the mod from a folder (for example with `--plugin-dir`). After that:

```powershell
npx -p typescript@5.6.3 tsc -p .
```

To try changes live, load the folder with `--plugin-dir` in an interactive session; saving a file reloads the mod. Set `thresholdMinutes` to `1` while testing.

## Licence

MIT
