# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and follows semantic versioning where
practical.

## [0.1.0] - 2026-04-14

### Added

- Clean-room Chrome extension for local browser control via a relay server
- Local Go relay server with client and extension WebSocket roles
- CLI with tab control, page actions, CDP passthrough, and screenshot helpers
- Batch page actions to reduce round-trips for agent workflows
- Human-like typing mode with per-character delay and jitter
- Hybrid DOM-plus-screenshot interaction flow with visible element descriptions
- Terminal-style popup UI with relay on/off and max-tab controls
- Strict relay tab pool with tab reuse instead of unbounded tab creation
- Direct npm CLI helpers:
  - `browser-relay relay-start`
  - `browser-relay extension-path`
  - `browser-relay package-root`
  - `browser-relay relay-url`

### Changed

- Replaced the earlier Node relay implementation with a Go relay server
- Switched screenshots to CDP-backed capture instead of foreground-only capture
- Removed one-off local testing scripts from the published package surface

### Security

- Removed local absolute paths and personal identifiers from tracked project files
- Kept the repository free of `.env` files, tokens, keys, and private credentials
