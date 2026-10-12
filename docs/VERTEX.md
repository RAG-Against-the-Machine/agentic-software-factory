# Claude Code on Vertex AI

Run the agent against **Claude models on Google Vertex AI** instead of Anthropic's
API. Billing lands on your GCP project, there is no Anthropic API key to rotate, and
authentication is your machine's **Application Default Credentials (ADC)** — never a
secret pasted into the Settings UI or stored in the org secret sink.

This is the daily-driver path on a corporate Mac where Claude Code must go through
Vertex. For the all-cloud GCP deployment (worker service account, `aiplatform.user`),
see [`HOSTING.md`](HOSTING.md) instead.

## When to pick it

| You want | Mode | Auth |
|---|---|---|
| Your own Claude Pro/Max plan, for your personal use only ([CLAUDE_USAGE.md](CLAUDE_USAGE.md)), no per-run cost figure | `oauth-token` | `claude setup-token` |
| Metered pay-as-you-go on an Anthropic key | `api-key` | `ANTHROPIC_API_KEY` |
| **Billing on a GCP project, Claude via Vertex** | **`vertex`** | **Google ADC** |

`vertex` mode is the right one when your org already pays Google, or policy requires
model traffic to stay inside GCP.

## 1. Enable the models in GCP

1. Pick (or create) a GCP project. Note its **project id** — this becomes
   `ANTHROPIC_VERTEX_PROJECT_ID`.
2. Enable the Vertex AI API on it (`aiplatform.googleapis.com`).
3. Enable the **Claude models** you intend to use in **Vertex AI → Model Garden**
   (each Claude model is enabled per project before it can be called).
4. Choose the **region** those models are served from. ASF defaults to
   `us-east5` (`CLOUD_ML_REGION`); set it to a region where your enabled models live.

## 2. Authenticate the host — Application Default Credentials

Run this **on the machine the worker runs on**, in a shell with a browser available:

```bash
gcloud auth application-default login
```

This writes ADC to `~/.config/gcloud/application_default_credentials.json`. That file
— and only that file — is how the agent authenticates to Vertex. It is provided by
the host: it never passes through the Settings UI, the registry, or the org secret sink.

## 3. Point ASF at Vertex

Two settings select `vertex` mode and name the project; the region has a working
default. Set them at the **environment tier** (they are env-only settings):

```bash
AGENT_AUTH_MODE=vertex
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
CLOUD_ML_REGION=us-east5            # default; change if your models live elsewhere
```

The worker's auth layer sets `CLAUDE_CODE_USE_VERTEX=1` for each agent spawn; you do
not set that yourself. No Anthropic credential is read in this mode — a stray
`ANTHROPIC_API_KEY` in the worker env is stripped before each spawn so it can't
silently re-route billing.

## Why host-worker (hybrid) mode

ADC lives in a **file on the host** (`~/.config/gcloud/…`). A worker that runs on
that host reads it directly; there is nothing to enter in **Settings** for `vertex`. That is why Vertex pairs with **host-worker mode**
(`scripts/setup.sh --mode 2`): Postgres, the registry and the api stay in containers,
and the worker runs on the machine that holds your ADC. See the host-worker section
of [`SELF_HOSTING.md`](SELF_HOSTING.md).

> All-container mode can also reach Vertex: `docker-compose.self-host.yml` mounts the
> host's `~/.config/gcloud` read-only into the worker container (override the source
> with `GCLOUD_CONFIG_DIR`). Host-worker mode is simpler because the file is just
> *there* — no mount, no image rebuild.

## When the Google login expires

Every worker in `vertex` mode re-checks its Google login every `AGENT_AUTH_RECHECK_MS`
(5 minutes by default) by refreshing an access token. That is free: no model call. If
Google says the login has expired or was revoked (or no login is found, twice in a row):

- the worker **stops taking Claude tasks** but stays connected, and the setup checklist
  says why;
- you get **one** notification (web inbox and any notifier you set up), not one per check;
- a task that fails because of it says so in plain words.

Run `gcloud auth application-default login` on that computer. The worker notices within
about 5 minutes, checks Claude for real, and takes work again: no restart. Then press
**Retry role** on any run that failed meanwhile.

A service-account key that stops working is reported the same way, with the fix
"put a fresh key where `GOOGLE_APPLICATION_CREDENTIALS` points". Credential types the
worker can't refresh itself (workload identity federation, impersonation) are not watched:
the worker logs that once, and an expiry then shows up only as failed tasks. Bedrock is
not covered by this check.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Worker won't register; log says `AGENT_AUTH_MODE=vertex needs ANTHROPIC_VERTEX_PROJECT_ID` | The project id isn't set | Set `ANTHROPIC_VERTEX_PROJECT_ID` in the environment and restart the worker. |
| Notification "Google login on worker … stopped working"; the setup checklist says the worker can't run Claude; a task failed with "The Google login … has expired" | **ADC expired** or was revoked (company accounts often must sign in again every day or so) | Run `gcloud auth application-default login` on the computer running that worker. See [When the Google login expires](#when-the-google-login-expires). |
| Model-not-found / not-enabled errors | The Claude model or region isn't enabled on the project | Enable the model in Model Garden, or point `CLOUD_ML_REGION` at a region where it is. |
