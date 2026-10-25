# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/Flo-cg/guildmoji/security/advisories/new)
instead. Include:

- a short description of the issue and its impact
- steps to reproduce it
- the Guildmoji version or commit
- any relevant logs, with tokens and personal data removed

You can expect an initial response within a few days. Please give me a reasonable
amount of time to publish a fix before disclosing the issue publicly.

## Scope and threat model

Guildmoji is a local-only tool. The security model assumes:

- the browser and the Node.js process run on the same trusted machine
- the Discord token belongs to the person running the tool
- other local users cannot read the process memory or `./data`

The server binds to `127.0.0.1` by default, rejects foreign `Host`/`Origin`
headers, uses a Content Security Policy, and keeps the token in memory only.

Reports about the following are especially welcome:

- token leakage through HTTP responses, logs, ZIPs, or the web UI
- authentication/authorization bypasses
- path traversal or unsafe ZIP entry names
- cross-site request forgery or DNS rebinding against the local server
- denial of service caused by a malicious Discord response or ZIP input

## Discord account safety

Using a user token for automated requests is commonly called "self-botting" and
may violate Discord's Terms of Service. Guildmoji only performs read requests and
downloads public CDN assets, but you use it at your own risk. Never share your
token, and revoke it by changing your Discord password if it is exposed.
