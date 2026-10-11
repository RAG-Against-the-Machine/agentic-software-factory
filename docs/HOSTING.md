# Hosting Addendum — running the factory on GCP

*Addendum to `IMPLEMENTATION_PLAN.md`. Audience: the DevOps/infra engineer standing this up. Written against the M3 codebase (registry · api · worker · web + Postgres).*

## 0. Decisions this addendum makes

| Decision | Choice | Why |
|---|---|---|
| Primary platform | **Google Cloud Run + Cloud SQL (Postgres 16)** | Every service is a long-lived Node process with streaming (SSE), a persistent DB `LISTEN`, and a background sweeper — none of which fit serverless functions. Cloud Run runs containers with always-on CPU; Cloud SQL is managed Postgres. The team already operates Cloud Run (podium). |
| Web tier | **Served by the api container** | One origin: no CORS, and the SSE stream goes straight to the api with no proxy hop. A separate static host adds a hop in front of a long-lived event stream for no gain. |
| Auth at the edge | **Identity-Aware Proxy (IAP)** in front of the api/web | The app has no login. IAP gives Google-identity SSO with zero code, and later the user's email arrives as a header the app can record as `dispatched_by`. |
| Worker placement | **Cloud Run service, always-on CPU, min 1 instance** for MVP; **GCE VM + persistent disk** when repos are large (§4.3) | Cloud Run's disk is memory-backed and ephemeral; fine for small repos once progress is pushed to git (H.3). A VM keeps worktrees across restarts. |
| Agent auth in containers | **Claude Code via Vertex AI** (`CLAUDE_CODE_USE_VERTEX=1`) with the worker's service account; `ANTHROPIC_API_KEY` from Secret Manager as the fallback | No API-key secret to rotate; billing lands on the GCP project. |
| Environments | `asf-staging` and `asf-prod` as **separate GCP projects** | Same Terraform/gcloud, different project id. Nothing else differs. |

Everything below assumes a single team, one region (`us-central1`), and a private VPC. Multi-region and multi-tenant are out of scope.

## 1. Topology

```
                     ┌─────────────── Identity-Aware Proxy ───────────────┐
  browser ─HTTPS──▶  │  Cloud Run: asf-api  (ingress: all, IAP-gated)      │
                     │   • serves the built web bundle at /                 │
                     │   • /api/* routes, /api/events SSE                   │
                     └───────────────┬───────────────────────┬──────────────┘
                                     │ X-Run-Secret          │ ticket / SCM tokens (Secret Manager)
                         Direct VPC egress                   ▼
                                     ▼                  Jira / GitHub / GitLab
                     ┌───────────────────────────────┐
                     │ Cloud Run: asf-registry        │◀──── Cloud Run: asf-worker (×N)
                     │ ingress: internal · max=1      │       always-on CPU, no ingress,
                     │ LISTEN/NOTIFY, sweeper, SSE    │       git + claude CLI, Vertex AI
                     └───────────────┬────────────────┘
                                     │ private IP
                     ┌───────────────▼────────────────┐
                     │ Cloud SQL Postgres 16 (private) │
                     └────────────────────────────────┘
```

Rules that must hold in any deployment (they are architectural, not preferences):

- **Exactly one registry instance.** It owns the sweeper and the single `LISTEN` connection; two registries means two sweepers racing. `--min-instances=1 --max-instances=1`.
- **Only the registry has `DATABASE_URL`.** The api and worker never get it.
- **Only the api has ticket/SCM credentials.** The worker receives a per-run clone credential over HTTP; the agent process receives none.
- **`RUN_EVENT_SECRET` is identical on all three services** and is set explicitly (the registry generates one when blank — fine on a laptop, useless across containers).
- **The registry's ingress is internal.** Nothing outside the VPC can reach `/internal/*` or the worker routes.

## 2. Code changes required before hosting (WP H.0–H.6)

These are small and belong in one PR before the first deploy. None change behavior in local dev.

| WP | Change | Files |
|---|---|---|
| **H.0** | **Honor `PORT` and bind `0.0.0.0`.** Cloud Run injects `PORT` and expects the container to listen on it. `port = PORT ?? REGISTRY_PORT` / `API_PORT`; `host = HOST ?? (PORT ? '0.0.0.0' : '127.0.0.1')`. | `apps/registry/src/config.ts`, `apps/api/src/config.ts` |
| **H.1** | **Worker health listener.** Cloud Run services must listen on `PORT`; the worker currently has no server. Add a minimal HTTP server answering `GET /health` with `{ ok, running, maxConcurrent, runtime }`. Also useful for the fleet dashboard later. | `apps/worker/src/index.ts` |
| **H.2** | **api serves the web bundle.** `WEB_DIST` env → `@fastify/static` at `/` with an SPA fallback to `index.html` for non-`/api` paths. The web build must call the api on the same origin (it already uses relative `/api/...`). | `apps/api/src/index.ts`, `apps/api/package.json` |
| **H.3** | **Durable progress: push after every writing role.** Today commits stay local until `publish:push_open`; an ephemeral worker disk would lose an implementer's work on restart. After a writing role finishes `done`, push the run branch (`--force-with-lease`) as work-in-progress. `ensureWorkspace` then recovers a lost worktree from the remote branch. | `apps/worker/src/segment.ts`, `apps/worker/src/git.ts` |
| **H.4** | **Record the IAP identity.** When `X-Goog-Authenticated-User-Email` is present, use it as `by` on dispatch and gate decisions instead of the web's hard-coded `'operator'`. Header is trustworthy only behind IAP — gate it on an `IAP_ENABLED=1` env. | `apps/api/src/routes/dispatch.ts`, `routes/browser.ts` |
| **H.5** | **Dockerfiles** (three images; the api image builds the web bundle in a stage). Worker image: `node:22-slim` + `git` + `@anthropic-ai/claude-code`. Non-root user, `pnpm deploy --prod` per app. | `apps/{api,registry,worker}/Dockerfile`, `.dockerignore` |
| **H.6** | **Deploy pipeline** — GitHub Actions on push to `main`: build → push to Artifact Registry → `gcloud run deploy` registry, then api, then worker. Auth by Workload Identity Federation (no key files). | `.github/workflows/deploy.yml` |

Optional but cheap: **H.7** `GET /api/fleet` on the api (proxies the registry's `/workers`) so the web can show *No worker connected* — the single most common "why is my run queued?" answer.

## 3. GCP resources to create (in order)

Names assume project `asf-prod`, region `us-central1`. Substitute `asf-staging` for staging.

### 3.1 Project & APIs
```bash
gcloud config set project asf-prod
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com compute.googleapis.com aiplatform.googleapis.com \
  cloudbuild.googleapis.com iamcredentials.googleapis.com
```

### 3.2 Network
- VPC `asf-vpc`, subnet `asf-subnet` (`10.10.0.0/24`), region `us-central1`.
- Private services access for Cloud SQL (`gcloud compute addresses create google-managed-services-asf-vpc --global --purpose=VPC_PEERING --prefix-length=16 --network=asf-vpc` then `gcloud services vpc-peerings connect …`).
- Cloud Run services use **Direct VPC egress** into `asf-subnet` (no Serverless VPC connector needed).

### 3.3 Database — Cloud SQL Postgres 16
```bash
gcloud sql instances create asf-pg --database-version=POSTGRES_16 --tier=db-custom-1-3840 \
  --region=us-central1 --network=asf-vpc --no-assign-ip --storage-auto-increase \
  --backup-start-time=08:00 --enable-point-in-time-recovery
gcloud sql databases create asf --instance=asf-pg
gcloud sql users create asf --instance=asf-pg --password="$(openssl rand -base64 24)"
```
- Private IP only. Record the IP: `gcloud sql instances describe asf-pg --format='value(ipAddresses[0].ipAddress)'`.
- `DATABASE_URL=postgres://asf:***@<private-ip>:5432/asf` → Secret Manager (`asf-database-url`).
- Migrations run **at registry boot** (`DATABASE_MIGRATE=1`, default). With `max-instances=1` this is safe. They are additive-only and checksummed; a changed shipped migration refuses to boot — that is the intended failure.
- *Alternative for a fast staging stand-up:* a managed Postgres with a public TLS URL (Neon/Supabase). Append `?sslmode=require`. No VPC work. Not for prod.

### 3.4 Secrets — Secret Manager
| Secret | Used by | Notes |
|---|---|---|
| `asf-run-event-secret` | registry, api, worker | `openssl rand -hex 32`. Same value everywhere. |
| `asf-database-url` | registry only | |
| `asf-github-token` | api (and worker only if not using per-run creds) | Fine-grained PAT or GitHub App token; `repo` + `issues` scopes. |
| `asf-jira-api-token` | api | With `JIRA_EMAIL`, `JIRA_BASE_URL` as plain env. |
| `asf-anthropic-api-key` | worker | **Only if not using Vertex** (§4.3). |

Grant each service account `roles/secretmanager.secretAccessor` on exactly the secrets it needs — not project-wide.

> **UI-configured providers vs Secret Manager.** The ticket provider and its
> credentials can also be set entirely in **Settings** at runtime; a
> UI-entered token is stored write-only in Postgres (`org_secret`), addressed by
> the `secret://org/<KEY>` pointer, and never leaves the api. For a managed
> cloud deploy prefer Secret Manager and the **env** tier (which wins over the
> UI-set org tier) so credentials live in one audited store and rotate there —
> `SECRETS_SOURCE=gcp` resolves `secret://` env values from Secret Manager. Use
> the UI path for GitHub Enterprise / Trello where you'd otherwise not manage a
> secret, or for a white-label instance an operator configures themselves. See
> [`PROVIDERS.md`](PROVIDERS.md). (Trello adds `TRELLO_KEY` + `TRELLO_TOKEN` if
> configured via env instead of the UI.)

### 3.5 Service accounts (least privilege)
| SA | Roles |
|---|---|
| `asf-registry@` | `cloudsql.client` (if using the Cloud SQL proxy path), secret accessor on `asf-database-url`, `asf-run-event-secret` |
| `asf-api@` | secret accessor on `asf-run-event-secret`, `asf-github-token`, `asf-jira-api-token`; `run.invoker` on `asf-registry` |
| `asf-worker@` | secret accessor on `asf-run-event-secret` (+ `asf-anthropic-api-key` if used); `aiplatform.user` (Vertex); `run.invoker` on `asf-registry` and `asf-api` |
| `asf-deploy@` (CI) | `run.admin`, `artifactregistry.writer`, `iam.serviceAccountUser` on the three runtime SAs — bound to the GitHub repo via Workload Identity Federation |

### 3.6 Artifact Registry
`gcloud artifacts repositories create asf --repository-format=docker --location=us-central1`. Images: `us-central1-docker.pkg.dev/asf-prod/asf/{registry,api,worker}:<git-sha>`.

## 4. Cloud Run services

All three: `--region=us-central1 --network=asf-vpc --subnet=asf-subnet --vpc-egress=private-ranges-only --execution-environment=gen2`.

### 4.1 `asf-registry`
```bash
gcloud run deploy asf-registry --image=…/registry:$SHA --service-account=asf-registry@… \
  --ingress=internal --no-allow-unauthenticated \
  --min-instances=1 --max-instances=1 --no-cpu-throttling --cpu=1 --memory=1Gi --timeout=3600 \
  --set-secrets=DATABASE_URL=asf-database-url:latest,RUN_EVENT_SECRET=asf-run-event-secret:latest \
  --set-env-vars=LOG_LEVEL=info,STALE_AFTER_MIN=15,WORKER_TTL_SECONDS=90,RECONCILE_INTERVAL_MS=60000,EVENT_RETENTION_DAYS=90
```
- `--no-cpu-throttling` (always-on CPU): the sweeper timer and the `LISTEN` connection must run between requests.
- `--timeout=3600`: the SSE route `/internal/events/runs` holds a request open; Cloud Run caps it at 60 min and the api reconnects. Expected.
- Startup probe: `GET /health` must return `db: true`. A registry with no database would accept a dispatch and lose it, so it exits non-zero instead; Cloud Run then fails the revision. That is correct.

### 4.2 `asf-api`
```bash
gcloud run deploy asf-api --image=…/api:$SHA --service-account=asf-api@… \
  --ingress=all --no-allow-unauthenticated \
  --min-instances=1 --max-instances=3 --no-cpu-throttling --cpu=1 --memory=1Gi --timeout=3600 --concurrency=80 \
  --set-secrets=RUN_EVENT_SECRET=asf-run-event-secret:latest,GITHUB_TOKEN=asf-github-token:latest,JIRA_API_TOKEN=asf-jira-api-token:latest \
  --set-env-vars=REGISTRY_URL=https://asf-registry-<hash>-uc.a.run.app,TICKET_PROVIDER=github,SCM_PROVIDER=github,GITHUB_REPOS=org/repo,WEB_DIST=/app/web,IAP_ENABLED=1,LOG_LEVEL=info
```
- `--no-allow-unauthenticated` + **IAP**: enable IAP for the service (`gcloud beta run services update asf-api --iap`, or via a global external HTTPS load balancer with a serverless NEG if you need a custom domain + Cloud Armor). Grant users/groups `roles/iap.httpsResourceAccessor`.
- Multiple api instances are fine: each holds its own upstream SSE to the registry, and every registry event reaches every api. `dispatched_by`/gates are recorded by the registry, not in api memory.
- `--timeout=3600` for `/api/events`; `EventSource` in the browser reconnects automatically.

### 4.3 `asf-worker`
```bash
gcloud run deploy asf-worker --image=…/worker:$SHA --service-account=asf-worker@… \
  --ingress=internal --no-allow-unauthenticated \
  --min-instances=1 --max-instances=2 --no-cpu-throttling --cpu=4 --memory=8Gi --timeout=3600 --concurrency=1 \
  --set-secrets=RUN_EVENT_SECRET=asf-run-event-secret:latest \
  --set-env-vars=REGISTRY_URL=https://asf-registry-…run.app,BFF_URL=https://asf-api-…run.app,AGENT_RUNTIME=claude-code,WORKER_MAX_CONCURRENT=2,WORKTREE_ROOT=/tmp/asf-worktrees,RUN_DATA_ROOT=/tmp/asf-runs,SEGMENT_TIMEOUT_MS=2700000,CLAUDE_CODE_USE_VERTEX=1,CLOUD_ML_REGION=us-east5,ANTHROPIC_VERTEX_PROJECT_ID=asf-prod,WORKER_DRY_RUN=0
```
- **Always-on CPU and min 1**: the worker is a poller, not a request handler. Nothing calls it (the `/health` listener from H.1 is for Cloud Run, not for traffic).
- **Memory is disk.** `/tmp` is tmpfs and counts against `--memory`. 8Gi is enough for small/medium repos plus `npm install`. Watch `container/memory/utilizations`.
- **Fleet capacity** = instances × `WORKER_MAX_CONCURRENT`. Scale by `--max-instances`; the registry's claim query (`SKIP LOCKED`) makes N workers safe.
- **Restart semantics**: Cloud Run sends `SIGTERM` (10 s grace). The worker deregisters, which stales anything it held; the run is resumable from the UI, and with H.3 the branch is already on the remote. A `kill -9` is covered by the sweeper after `WORKER_TTL_SECONDS`.
- **Claude Code via Vertex**: the three `CLAUDE_CODE_USE_VERTEX` / `CLOUD_ML_REGION` / `ANTHROPIC_VERTEX_PROJECT_ID` vars plus `roles/aiplatform.user` on the SA. Enable the Claude models in Vertex Model Garden first. Verify once with `claude -p "say pong" --output-format json` inside the container (`gcloud run jobs execute` a one-off, or exec into a GCE test VM) — the result envelope's `total_cost_usd` may be `0` on Vertex, in which case the worker prices usage from tokens (`priceUsage`), which is already the fallback.
- **When to use a GCE VM instead**: repos over a few GB, builds that need >8Gi, or you want worktrees to survive restarts as evidence. `e2-standard-4` + 100 GB pd-balanced, the worker under `systemd` with the same env from Secret Manager (`gcloud secrets versions access`), `WORKTREE_ROOT=/var/lib/asf/worktrees`. Or a MIG of those for scale. Everything else is identical.

## 5. Deploy pipeline (H.6)

`.github/workflows/deploy.yml`, on push to `main` (after CI is green):

1. `google-github-actions/auth` with Workload Identity Federation → `asf-deploy@`.
2. Build three images with `docker buildx` (api image runs `pnpm --filter @asf/web build` in a stage and copies `dist/` to `/app/web`). Tag with the git SHA.
3. Push to Artifact Registry.
4. Deploy **registry → api → worker** in that order (the registry applies migrations at boot; a new api/worker may depend on a new column).
5. Smoke: `curl $REGISTRY/health` (needs an identity token: `gcloud auth print-identity-token`) shows `db: true` and the expected `migrations` count; `curl $API/health` through IAP with a service-account token.

Rollback = `gcloud run services update-traffic asf-<svc> --to-revisions=<prev>=100`. Because migrations are additive-only, an older api/worker keeps working against a newer schema.

Staging gets every merge to `main`; prod is promoted by re-running the workflow with `environment: prod` (a GitHub Environment with a required reviewer).

## 6. Day-2 operations

| Concern | What to set up |
|---|---|
| Logs | All three log JSON to stdout → Cloud Logging. Useful filters: `jsonPayload.msg="sweep"`, `jsonPayload.kind="run:stale"`, `severity>=ERROR`. |
| Alerts | (1) Uptime check on api `/health` (through IAP with a SA). (2) Log-based metric on registry `/health` `db:false`. (3) Log-based metric on worker `"msg":"claim failed"` rate. (4) Cloud SQL disk > 80 %. (5) Cost: budget alert on the project — the LLM spend is the variable cost. |
| "No worker connected" | Registry `GET /workers` (with the secret) is the truth; H.7 surfaces it in the UI. If empty in prod: the worker revision failed its startup probe or Vertex auth. |
| Backups | Cloud SQL automated daily + PITR (set above). `run_events` prunes itself at `EVENT_RETENTION_DAYS`; `agent_run` is kept forever by design. |
| Secret rotation | Rotate `asf-run-event-secret` by adding a new version and redeploying all three services in one pipeline run — they must agree at every moment, so do it in a maintenance window or accept a minute of `401`s from workers (they retry). |
| Cost ceiling | `DISPATCH`-time `maxCostUsd` is enforced per run by the orchestrator (`halted`). Set a sane team default in the dispatch template and a project budget alert as the backstop. |
| Worktree GC | Cloud Run: nothing to do (instance restarts clear `/tmp`). GCE: cron `scripts/gc-worktrees.mjs` (to be written) removing worktrees of terminal runs older than 7 days. |

Run-rate: see §9 (cost comparison). LLM spend is the real number and is per run (`costUsd` on every run).

## 7. Ownership split

| DevOps/infra provides | Engineering (this repo) provides |
|---|---|
| Projects, VPC, Cloud SQL, Secret Manager entries, service accounts, WIF binding, IAP, Artifact Registry, budget alerts | WP H.0–H.6 (PORT/host, worker `/health`, static web, WIP push, IAP identity, Dockerfiles, deploy workflow) |
| Vertex AI model enablement, worker SA `aiplatform.user` | Verifying `claude -p` under Vertex inside the worker image and the `priceUsage` fallback |
| Uptime checks, log-based alerts, dashboards | JSON log fields to key on (already emitted), H.7 fleet endpoint |
| Staging → prod promotion policy (GitHub Environment reviewers) | `scripts/m1-smoke.mjs` / `m3-smoke.mjs` usable against a deployed environment (they take `REGISTRY_URL`/`API_URL`) |

## 8. First-deploy verification checklist

1. `asf-registry` revision healthy; `/health` → `{ ok:true, db:true, migrations:2 }`.
2. `asf-api` `/health` through IAP → `{ tickets:'github', scm:'github' }` (preflight passed — a bad token fails the revision, by design).
3. `asf-worker` logs `registered; polling for tasks`; registry `GET /workers` lists it.
4. Open the web URL through IAP: backlog lists real tickets from the provider.
5. Dispatch a **scratch ticket against a scratch repo** with `WORKER_DRY_RUN=1` on the worker first: run reaches the plan gate, plan text is real (Vertex works), approve, roles complete, `publish:push_open` is a no-op in dry-run.
6. Flip `WORKER_DRY_RUN=0`, repeat: a draft PR appears on the scratch repo; `before_merge` gate parks; approve; PR merges. **This is the hosted acceptance test** (mirrors WP 4.4).
7. Kill the worker revision mid-run: the run goes `stale` within `WORKER_TTL_SECONDS`, *Resume* in the UI re-queues it, and (with H.3) the branch on the remote already has the implementer's commits.

## 9. Cost comparison — GCP vs AWS vs your own hardware

Three ways to run the same four processes + Postgres. Prices are **US-region list prices, approximate, as of this document** (re-quote before budgeting; cloud list prices move, and committed-use discounts of ~15–20 % apply to steady always-on services). The workload profile assumed throughout: **one team, one always-on worker (4 vCPU / 8 GB), registry + api always-on, ~20 runs/day**.

### 9.1 The number that matters first: LLM tokens

Infra is the small number. A four-role run (planner → implementer → tester → reviewer on Sonnet-class models, a medium ticket) costs roughly **$2–8 in tokens**; a big ticket or a review loop can be $15+. At 20 runs per working day that is **≈ $1,500–3,500 / month**, and it is the same on every platform — Vertex AI and Bedrock bill Claude at Anthropic's per-token list price. So the hosting choice moves the total by ±10–20 %; the team's dispatch habits and `maxCostUsd` ceilings move it by 3×. Optimize the team template (cheaper models for tester/reviewer) before optimizing the cloud bill.

### 9.2 Monthly infrastructure, prod only

| Component | **GCP** (Cloud Run + Cloud SQL) | **AWS** (ECS Fargate + RDS) | **Own hardware** (Docker Compose) |
|---|---|---|---|
| Postgres | Cloud SQL `db-custom-1-3840`, 20 GB, PITR — **~$55** | RDS `db.t4g.medium` Postgres 16, 20 GB gp3, backups — **~$55** (`db.t4g.small` ~$30 is enough) | container + volume — **$0** |
| registry (1 vCPU / 1 GB, always-on) | Cloud Run always-allocated CPU — **~$52** | Fargate 1 vCPU / 2 GB — **~$36** | **$0** |
| api (1 vCPU / 1 GB, always-on) | **~$52** | **~$36** | **$0** |
| worker (4 vCPU / 8 GB, always-on) | Cloud Run — **~$230**; *or* GCE `e2-standard-4` + 100 GB disk — **~$110** | Fargate — **~$145**; *or* EC2 `m6g.xlarge` + 100 GB — **~$120** | **$0** |
| Ingress / LB / auth | IAP: **$0**; Cloud Run URL TLS: **$0** (custom domain via HTTPS LB adds **~$20**) | ALB **~$20** + Cognito/ALB-auth (free at this scale); or Verified Access **~$30+** | Tailscale (free tier) or Caddy + Let's Encrypt — **$0** |
| Private networking | Direct VPC egress: **$0** | **NAT Gateway ~$35 + $0.045/GB** (needed for a private worker to reach GitHub/Bedrock; the usual surprise line) | **$0** |
| Registry/secrets/logs/egress | **~$15** | **~$15** | offsite backup (B2/S3, few GB) **~$2** |
| Power | — | — | ~100 W × 730 h ≈ 73 kWh ≈ **$11** at $0.15/kWh |
| **Total, Cloud Run/Fargate worker** | **≈ $400 / mo** | **≈ $340 / mo** | — |
| **Total, VM worker** | **≈ $285 / mo** | **≈ $300 / mo** | **≈ $15 / mo** |
| Staging (scale-to-zero api/registry, small DB, worker only when needed) | **~$80–100** | **~$90–110** | **$0** (same box, second compose project) |
| One-time | $0 | $0 | **$0** if reusing a machine you own; **$600–1,500** for a dedicated box (Mac mini M4 Pro / mini-PC 64 GB / used 1U) |

Notes on the table:
- The always-on worker dominates cloud cost. Cloud Run's per-vCPU-second price is expensive for a 4-vCPU box that idles between claims; a plain VM is ~half. That is why §4.3 offers the GCE path — and it's the same story on AWS (EC2 over Fargate).
- GCP's edge is **IAP** (SSO with zero code, $0) and **no NAT charge**. AWS's edge is nothing structural here — it is the right answer if the org already lives in AWS (IAM, existing VPC, Bedrock enablement) and the wrong answer to pick for price alone.
- Clouds scale the worker fleet with one flag (`--max-instances` / desired count); own hardware scales by buying another box.

### 9.3 What own-hardware actually costs (the part not on the invoice)

The Mac Studio this was built on (M2 Max, 32 GB) runs the full stack today under Docker Compose with room to spare; a $600 mini-PC does too. The dollars are near zero. The real costs:

| Cost | Own hardware | Cloud |
|---|---|---|
| Setup | ~half a day (Compose, Tailscale, backup cron) | 2–3 days (§3–§5), then near-zero |
| Ongoing ops | 2–6 h/mo: OS/Docker updates, disk, restarts, "why is it down" | 1–3 h/mo: mostly reviewing alerts and rotating a secret |
| Availability | Your power, your ISP, your disk. No HA. A sleeping/rebooting host stales every run (resumable, but someone notices) | 99.9 %+ managed; DB PITR; instances restart themselves |
| Security posture | Ticket/SCM tokens and an agent that **runs arbitrary repo code** live on a machine on your LAN. Use a **dedicated box or VM, not a daily-driver laptop**, and Tailscale/IAP-equivalent for access | Least-privilege SAs, Secret Manager, IAP, audit logs — all built in (§3.4–3.5) |
| Backups | You script them (pg_dump → B2 nightly; test a restore once) | Automated + PITR |
| Team access | Tailscale shares the box with a few people fine; more than ~5 operators or any non-technical user → cloud |
| Hidden requirement | The host must never sleep and must have a real static local path for worktrees; macOS TCC-protected folders and laptop sleep have already bitten scheduled jobs on this machine | — |

### 9.4 Recommendation by situation

| Situation | Choice | Why |
|---|---|---|
| **Now: one or two people evaluating whether the factory earns its keep** | **Own hardware** — the Mac Studio (or a dedicated mini-PC) + Docker Compose + Tailscale | ~$15/mo, half a day to set up, nothing to unwind if the experiment fails. Every dollar goes to tokens, which is what you're actually evaluating. |
| A team depends on it daily; runs must survive a reboot nobody noticed; multiple operators; someone non-technical opens the board | **GCP** (§0–§8), GCE worker variant | ~$285/mo buys managed Postgres with PITR, SSO via IAP, and a fleet you scale with a flag. Still 10–15 % of the token bill. |
| The org is already an AWS shop | **AWS** — ECS Fargate for registry/api, EC2 for the worker, RDS, ALB + Cognito, Claude via Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) | Equivalent, not cheaper. Budget the NAT gateway and accept that auth is more work than IAP. The code changes (H.0–H.6) are the same; only the runbook differs. |
| Hybrid worth considering | Registry + api + Postgres on GCP; **workers on your own hardware** joining over Tailscale/VPN | The worker is the expensive cloud piece and the only one with no inbound traffic — it just needs `REGISTRY_URL`/`BFF_URL`. Cuts the GCP bill to ~$175/mo while keeping managed state and SSO. Add a `WORKER_TTL` alert so a sleeping home box shows up as *No worker connected*. |

### 9.5 Own-hardware recipe (WP H.8)

To make the self-hosted path first-class rather than "run `pnpm dev` forever":

- `docker-compose.self-host.yml`: the four services + Postgres as containers, restart-always, named volumes for `pgdata`, `worktrees`, `runs`; env from `.env`; the api serving the web bundle (H.2). One command: `docker compose -f docker-compose.self-host.yml up -d`.
- Access: `tailscale serve --https=443 localhost:8787` (TLS + ACL + identity for free; Tailscale can also pass the user identity as a header, which H.4 can record the same way it records IAP's).
- Backups: a fifth container running nightly `pg_dump | gzip → rclone` to B2/S3; document a restore.
- Host requirements: never sleeps (`caffeinate` / server power profile), worktrees on a non-TCC path (`/opt/asf` or a Linux box), agent credentials entered in Settings → "Which AI should do the work?" (a `claude setup-token` subscription token or an API key); nothing needs to be logged in on the host.
- The same `scripts/m3-smoke.mjs` is the acceptance test against `http://<tailnet-host>`.

This is a small WP (one compose file, one doc section) and should ship before the GCP work if the near-term plan is to evaluate on your own hardware — it is the cheapest way to get the factory in daily use.