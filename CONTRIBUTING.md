# Contributing to Guildmoji

Thanks for taking the time to improve Guildmoji. This project intentionally
stays small: **no runtime npm dependencies**, no build step, and a vanilla web
front end.

## Before you start

- Search existing issues and pull requests first.
- For a larger feature or a behaviour change, open an issue so we can agree on
  the approach before you spend a lot of time on it.
- Never paste a real Discord token into an issue, PR, screenshot, or test
  fixture. Redact IDs and personal data too.

## Local setup

You only need Node.js 20 or newer and Git:

```bash
git clone https://github.com/Flo-cg/guildmoji.git
cd guildmoji
npm start
```

There are no dependencies to install. Run the test suite with:

```bash
npm test
```

The end-to-end test uses a mocked Discord API and a temporary data directory, so
it does not need an account or internet access.

## Code style

- CommonJS with two-space indentation; match the style of the surrounding code.
- Prefer small, focused functions and clear error messages.
- Keep the web UI dependency-free. Plain HTML, CSS, and JavaScript only.
- Do not add analytics, telemetry, remote fonts, or external scripts.
- Add tests for behaviour changes. A bug fix should include a regression test
  when it is practical to do so.

## Pull requests

- Keep pull requests focused; split unrelated changes.
- Describe what changed, why, and how you tested it.
- Update `README.md` when user-facing behaviour changes.
- Make sure `npm test` passes on your machine.
- If you add an image or asset, confirm that you have the right to distribute it.

## Reporting bugs

Use the bug report form. Useful details include:

- operating system and desktop environment
- Node.js version
- whether you used the desktop app or the web version of Discord
- the exact error message
- steps to reproduce

Please remove tokens, user IDs, and server names from logs and screenshots.

## Security

Do not report security vulnerabilities in public issues. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the MIT
License.
