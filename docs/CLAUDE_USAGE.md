# Using Claude responsibly

ASF runs coding agents. For Claude, that agent is **Claude Code**, Anthropic's CLI, and
Anthropic's terms decide how you may sign it in. This page explains what those terms
mean for an ASF install. Anthropic's own page is the authority, not this summary:
[Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
This isn't legal advice. If your use case is unusual, ask Anthropic.

## What ASF does

- The worker image installs **Claude Code unmodified**, as published on npm. ASF doesn't
  patch it or remove any of its sign-in methods.
- ASF doesn't sell, resell or proxy Claude usage. **Every install brings its own
  credential**, and the usage is billed to whoever owns that credential.
- ASF isn't made, endorsed or supported by Anthropic.

## Which credential to use

| You are… | Use | Why |
|---|---|---|
| A team, or anyone sharing the factory with other people | **Claude API key** (recommended), **Vertex AI** or **Bedrock** | Billed to the key owner under their own agreement. Each job shows a real cost. |
| One person running the factory for your own work | API key, or **your own** Claude Pro/Max subscription | Anthropic allows you to sign the unmodified CLI in with your own subscription. |
| Hosting ASF for other people (clients, colleagues, a company) | Each of them supplies **their own** API key or cloud credential | You may not pay for, resell or intermediate their Claude usage. |

## Rules for a Claude subscription (`AGENT_AUTH_MODE=oauth-token`)

A subscription token from `claude setup-token`, or a host `claude login`, is for **its
owner's own use**:

- **Don't share one subscription between people.** Anthropic doesn't allow routing other
  people's requests through one Free/Pro/Max login. If several people sign in to your
  factory (`AUTH_MODE=header` behind Tailscale, IAP or SSO), use an API key. ASF warns
  about this setup in **Settings → Which AI should do the work?**, on `/setup`, and in
  `asf doctor`.
- **Plan limits assume ordinary, individual use.** A queue running agents around the
  clock can hit them, or draw enforcement. For heavy or unattended use, an API key is
  the better fit.
- **Get the token through Anthropic's own sign-in flow** (`claude setup-token`, or
  `claude login` on a host worker). ASF keeps the resulting token in its write-only
  secret store (in your own Postgres, encrypted at rest, never sent back to the browser) so the worker can
  use it. ASF never asks for your Claude password.

## Names and logos

You can say in plain text that ASF *runs Claude Code*. Don't use the Claude or Anthropic
names or logos in your product name or logo, or in a way that suggests Anthropic
endorses you. See Anthropic's [trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines).

## Other agents

OpenAI Codex, OpenCode and GitHub Copilot CLI have their own terms. The same principle
holds: each operator brings their own account or key, and you check that provider's
terms before sharing one credential.
