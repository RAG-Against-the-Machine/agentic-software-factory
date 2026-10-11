# Security policy

ASF holds tracker and SCM credentials and runs coding agents that execute repository
code. Security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://github.com/RAG-Against-the-Machine/agentic-software-factory/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You should
get an acknowledgement within a few days. Once a fix ships, the advisory is
published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## Scope and threat model

In scope, for example:
- a credential (ticket/SCM token, agent key, org secret) reaching the browser, the
  registry, an agent process, logs, or a run artifact
- bypassing a human gate, especially `before_merge`
- an agent writing outside its run's worktree, or pushing to a forbidden branch
- authentication/identity bypass when `AUTH_MODE=header`

Expected behaviour, not a vulnerability:
- the worker runs agent CLIs with their own sandboxes disabled **inside the worker
  container**. The container is the isolation boundary. Run the worker on a dedicated
  host or VM, not on a machine holding unrelated secrets.
- with `AUTH_MODE=none`, anyone who can reach the api port is the operator. Bind it to
  loopback and put an authenticating proxy in front (see `docs/SELF_HOSTING.md`).
