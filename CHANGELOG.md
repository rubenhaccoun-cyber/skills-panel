# Changelog

## 0.3.0 - 2026-10-10

- Tabs below Active: Suggested, Discover and Top used. The pane remembers the last one.
- Discover tab: popular skills you have not installed, from the skills.sh search, 1,000 installs at least. Clicking one adds its install command to the prompt.
- The search runs after the prompt has gone on, so Claude never waits for it. Only 2 to 4 keywords are sent, never the prompt.
- New `discover` setting to turn it off.
- Top used shows up to 10 skills, now that it has a tab of its own.
- Tags use fixed colors with white text, readable in the terminal and in the desktop app.

## 0.2.0 - 2026-10-09

First public release.

- Pane with three blocks: Active, Suggested, Top used.
- Suggestions scored 1 to 10 by Haiku, from the full skill catalog and the last four messages.
- Suggestions at or above a set score are passed to Claude with the prompt.
- Skills named in the project's `CLAUDE.md` are boosted; skills it forbids are never suggested.
- Usage history per project, with a project / all projects switch and tag filters.
- `/skills-panel`, `/skills-rescan`, `/skills-stats` commands.
- Settings: language (English, French), minimum score shared with Claude, maximum suggestions, sharing on or off.
