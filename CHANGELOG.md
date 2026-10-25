# Changelog

All notable changes to Guildmoji are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-25

### Added

- Searchable grid of every custom emoji and sticker from every Discord server
  the account belongs to.
- Server sidebar, text search, emoji/sticker/animated filters, and PNG sizes
  of 128, 256, or 512 px.
- Selection that survives page reloads, plus "select all shown".
- Background ZIP export with progress, cancellation, and a download modal.
- One folder per server, a `stickers/` subfolder, and a detailed `manifest.json`
  with source URLs, notes, and failed assets.
- Animated emoji and APNG stickers exported as a still PNG of the first frame.
- Optional `ffmpeg` fallback for GIF/WebP assets and Lottie handling.
- Automatic saved-token discovery for Discord desktop, Vesktop, Vencord,
  Equicord, Legcord, ArmCord, Dorion, Flatpak, and Snap installations.
- Dependency-free LevelDB table/WAL reader with Snappy support.
- Manual token login with updated Network and Local Storage instructions.
- Local-only server with Host/Origin checks, CSP, and in-memory token storage.
- Metadata cache, rate-limit-aware Discord requests, and per-server error
  reporting.
- Responsive dark UI with mobile sidebar and keyboard-accessible controls.
- End-to-end tests with a mocked Discord API and unit tests for conversion,
  sanitising, ZIP writing, and size validation.
- CI for Node.js 20, 22, and 24.

[1.0.0]: https://github.com/Flo-cg/guildmoji/releases/tag/v1.0.0
