# Changelog

## 2026.09.19.1

- Initial release: `@magistr/manim/scene` model drives the ManimCommunity CLI to
  render a Python-defined `Scene` into an mp4/gif/png/webm, capturing the media
  file, CLI log, and render metadata as swamp data.
- Configurable `command` invocation prefix (default `["manim"]`; supports `uvx`
  / `docker` wrappers).
- Pure domain layer plus injected subprocess/filesystem seams; 20 unit tests.
