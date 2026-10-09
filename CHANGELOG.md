# Changelog

## 0.2.0 - 2026-10-09

First public release.

- Pane with three blocks: Active, Suggested, Top used.
- Suggestions scored 1 to 10 by Haiku, from the full skill catalog and the last four messages.
- Suggestions at or above a set score are passed to Claude with the prompt.
- Skills named in the project's `CLAUDE.md` are boosted; skills it forbids are never suggested.
- Usage history per project, with a project / all projects switch and tag filters.
- `/skills-panel`, `/skills-rescan`, `/skills-stats` commands.
- Settings: language (English, French), minimum score shared with Claude, maximum suggestions, sharing on or off.
