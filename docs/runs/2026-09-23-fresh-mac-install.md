# Fresh-Mac install — logged run (2026-09-23)

The milestone's human evidence that ASF installs on a clean Mac: clone → first
ticket dispatched and visible in **Today**, with every prompt the operator saw
and every friction, turned into follow-up issues.

> **Template — fill this in during the actual run.** The CI `install-e2e` job
> proves the *containers* path on a clean Ubuntu box automatically; this file is
> the one thing CI can't produce: a real person on a real Mac, timing the walk
> from `git clone` to a run showing up in **Today**, and writing down what tripped
> them up. Replace every `<…>` placeholder with what actually happened, then link
> the follow-ups. Do not invent timings or frictions — an empty section is better
> than a fabricated one.

## Machine

- Model / chip: `<e.g. MacBook Air M2>`
- macOS: `<version>`
- Docker: `<Docker Desktop / Rancher / Colima + version>`
- Starting state: `<fresh checkout dir, e.g. ~/asf; anything preinstalled>`

## Timeline (clone → Today)

| step | wall-clock | notes |
| --- | --- | --- |
| `git clone …` | `<mm:ss>` | |
| `./scripts/setup.sh` finishes (URL printed) | `<mm:ss>` | first image build is the long pole |
| `/setup` checklist opened | `<mm:ss>` | |
| Providers configured (tracker + SCM) | `<mm:ss>` | |
| Agent auth pasted in Admin | `<mm:ss>` | |
| first ticket dispatched | `<mm:ss>` | |
| run visible in **Today** | `<mm:ss>` | **clone → Today total: `<mm:ss>`** |

## Every prompt the operator saw

Transcribe each interactive prompt from `setup.sh` and the `/setup` checklist, in
order, with the answer given:

1. `<prompt text>` → `<answer>`
2. …

## Frictions

Anything that was confusing, slow, or needed a workaround — however small:

- `<friction>` → follow-up: `<link to issue, or "none — acceptable">`
- …

## Follow-up issues filed

- `<#NNN — title>`
- …
