---
title: Install Project Brain
sidebar_label: Install
sidebar_position: 1
description: Deploy Project Brain on a single VM with Docker Compose.
---

# Install Project Brain

Use this guide for a production deployment. For local development, see the [README](../README.md).

Project Brain is a single-tenant Docker Compose stack. Each customer runs their own deployment; there is no shared SaaS environment.

## Requirements

- Linux VM: Ubuntu 22.04+, Debian 12+, RHEL 9+, or similar
- Public DNS name pointed at the VM, such as `brain.acme.com`
- Docker Engine 24+ with Compose v2
- OpenSSL
- An API key for Google Gemini, Anthropic Claude, or OpenAI

Open inbound `80/tcp` and `443/tcp`. Keep `5432`, `6379`, `3000`, and `8080` closed; those ports are internal to Docker.

## VM sizing

| Use case                            | Suggested VM                                              | Notes                                              |
| ----------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Trial or small team, up to 25 users | 4 vCPU / 8 GB RAM / 100 GB SSD                            | Good starting point                                |
| Production, up to 200 users         | 8 vCPU / 16 GB RAM / 250 GB SSD                           | Enough room for web, worker, database, and sidecar |
| Heavy LLM usage                     | Production size plus 100 GB for `/var/lib/docker/volumes` | LLM cost usually exceeds VM cost                   |

## Quick install

```bash
git clone https://github.com/Neusis-AI-Org/project-brain-releases.git
cd project-brain-releases
./scripts/install.sh
```

The installer asks for:

- App domain
- Super-admin email
- LLM provider
- Provider API key

It then writes `.env`, generates secrets, pulls images, runs migrations, starts the stack, and checks readiness.

The public release repository contains installer assets only. The Project Brain source repository remains private; customer deployments pull signed images from `ghcr.io/neusis-ai-org`.

When the installer reports `readiness=true`, open:

```text
https://<your-domain>
```

Sign in with the super-admin email you entered during setup.

## What gets installed

The installer creates:

- `.env`, mode `0600`, with generated secrets and deployment config
- App services: `web`, `worker`, `graphify-sidecar`, `graphify-egress-proxy`, `postgres`, `redis`
- `caddy` for TLS termination and automatic Let's Encrypt certificates
- `postgres-backup` for daily database backups in `./backups/postgres/`
- `workspace-backup` for nightly workspace backups in `./backups/workspace/`
- A super-admin account, promoted on first sign-in

The default `KMS_PROVIDER=local` keeps secrets in `.env` and encrypts stored credentials with `BRAIN_MASTER_KEY`. For a "no plaintext keys" deployment on AWS — KMS envelope encryption for credentials, a non-exportable KMS signing key for the GitHub App, and `<NAME>_FILE` secret injection from AWS Secrets Manager / Vault — set `KMS_PROVIDER=aws` and follow [the AWS KMS section in the security model](security.md#aws-kms-mode-no-plaintext-keys).

## Configure SSO

Production requires a real identity provider. The installer leaves `AUTH_AZURE_AD_*` blank, and the app refuses to run production auth with `DEV_AUTH_ENABLED=true`.

:::danger
A second flag, `DEMO_AUTH_ENABLED=true`, also enables the email-only credentials provider, and unlike `DEV_AUTH_ENABLED` it is honored even when `NODE_ENV=production`. It exists so prebuilt production images can be reused for public demo and staging deployments (where Next.js has already inlined `NODE_ENV` at build time). **Never set `DEMO_AUTH_ENABLED=true` on a deployment with real customer data** — it signs anyone in by email alone, with no password and no SSO. Leave it unset on customer installs.
:::

To configure Microsoft Entra ID:

1. Register an OIDC application in your Entra tenant.
2. Add this redirect URI:

   ```text
   https://<your-domain>/api/auth/callback/microsoft-entra-id
   ```

3. Create a client secret.
4. Update `.env`:

   ```env
   AUTH_AZURE_AD_TENANT_ID=...
   AUTH_AZURE_AD_CLIENT_ID=...
   AUTH_AZURE_AD_CLIENT_SECRET=...
   AUTH_ALLOWED_EMAIL_DOMAINS=acme.com
   ```

   `AUTH_AZURE_AD_TENANT_ID` may be a directory (tenant) ID, or `common` to
   accept any Microsoft account (work, school, or personal). `common` requires
   the app registration's _Supported account types_ to be multi-tenant —
   otherwise sign-in fails with `AADSTS50194`.

   Two allow-lists gate who may sign in, and a user passes if they match
   **either**:

   | Variable                     | Matches                                 |
   | ---------------------------- | --------------------------------------- |
   | `AUTH_ALLOWED_EMAIL_DOMAINS` | whole domains, e.g. `acme.com`          |
   | `AUTH_ALLOWED_EMAILS`        | exact addresses, e.g. `alice@gmail.com` |

   Use `AUTH_ALLOWED_EMAILS` to admit named individuals on consumer domains
   without opening all of `gmail.com`:

   ```env
   AUTH_ALLOWED_EMAIL_DOMAINS=
   AUTH_ALLOWED_EMAILS=alice@gmail.com,bob@outlook.com
   ```

   Leaving **both** empty accepts any email the IdP admits. With a
   single-tenant app that is just your own directory; with `common` it is
   every Microsoft account on the internet.

5. Restart the web service:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d web
   ```

## Configure Google sign-in (optional)

For users who have no account in your Entra tenant — contractors, pilot users,
anyone on `gmail.com`. Entra cannot authenticate them, so they need their own
provider.

1. In the Google Cloud console, create an **OAuth 2.0 Client ID** of type _Web
   application_.
2. Add this authorised redirect URI:

   ```text
   https://<your-domain>/api/auth/callback/google
   ```

3. Update `.env`:

   ```env
   AUTH_GOOGLE_CLIENT_ID=...
   AUTH_GOOGLE_CLIENT_SECRET=...
   ```

4. Recreate the web service (a restart will not re-read `.env`):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate --no-deps web worker
   ```

> **An allow-list is required.** Entra can be scoped to a single tenant;
> Google has no equivalent, so enabling this provider means Google will
> authenticate _any_ Google account on the internet. `AUTH_ALLOWED_EMAILS` /
> `AUTH_ALLOWED_EMAIL_DOMAINS` are the only thing standing between a stranger
> and a user record.
>
> Because of that, Google credentials **on their own do nothing**: with both
> allow-lists empty the provider refuses to load, logs an error explaining
> why, and the button stays hidden. Set an allow-list and it appears. This is
> deliberate — it removes any window in which a half-finished configuration is
> open to the internet.
>
> And because the two lists are OR'd, adding Google alongside Entra means you
> must list your own domain in `AUTH_ALLOWED_EMAIL_DOMAINS` — otherwise an
> addresses-only list locks out your whole staff.

Leaving both credential variables empty is also safe: the provider is never
constructed and the button is not rendered.

## Configure the LLM provider

Project Brain uses an LLM for two independent workloads: the **assistant chat** (in-app Q&A grounded on the knowledge graph) and the **graph builder** (the graphify sidecar that extracts the knowledge graph). Both run through the router sidecar, so there is one place credentials live. The assistant model is platform-wide; the graph builder model is chosen per project.

There are **no LLM environment variables**. Provider API keys are held by the router in its own encrypted store; Project Brain never has a copy. Nothing works until the router is onboarded — that is deliberate, so a deployment cannot quietly fall back to a directly-held provider key.

### 1. Onboard the router and connect a provider

```text
/admin/router
```

Select **Initialize router**, then connect a provider (Google AI Studio, OpenAI, Claude Code, ChatGPT (Codex), OpenRouter, Antigravity, and others). Connecting seeds a curated set of models for that connector, which you can adjust.

Give each connection a **Name** if you like — useful once one provider has several keys.

:::tip
Adding **several keys for the same provider** is how you get rate-limit headroom. Each key becomes its own account, and the router spreads traffic across them and cools down whichever one returns a 429. The model you pick stays the same.
:::

### 2. Pick the models

```text
/admin/ai                       assistant chat (super admin)
/projects/<slug>/settings       graph builder (any project member)
```

Choose a **connector** and a **model** in each place. The list is exactly the models curated on /admin/router; to use something else, add it there first. The assistant selection is stored on `platform_ai_settings`, the graph builder selection on each project's `project_graphify_settings` row; no credential is stored with them.

Until the assistant has a model it returns a 503. A project without a graph builder model records its graph runs as `llm_not_configured` unless its scope is code only, which needs no model. See [docs/graphify.md](graphify.md#project-settings) for the rest of the project settings.

:::note
Upgrading from a release that configured LLM providers through `.env` and `platform_ai_credentials`? Those settings are gone: migration `0012` drops the credential table and `0013` clears the old model selections, whose provider names and model ids cannot be expressed as router ids. Re-connect the provider on /admin/router and re-pick the models on /admin/ai.
:::

## LLM Router sidecar

The stack includes an [OmniRoute](https://github.com/diegosouzapw/OmniRoute) LLM gateway sidecar. It carries both Project Brain's own LLM calls (above) and any coding agents (neusis-code, Claude Code, …) you connect with API keys minted from the **/admin/router** tab. It is independent of any external LiteLLM deployment.

To let agents on other machines reach it, add a DNS A record for a router hostname and set in `.env`:

```env
ROUTER_DOMAIN=router.example.com
ROUTER_PUBLIC_URL=https://router.example.com
```

Project Brain's own calls do not need this — they use the internal `ROUTER_INTERNAL_URL`.

Full setup, key minting, and agent-connection instructions: [docs/router.md](router.md).

## Connect integrations

Super-admins manage integrations at:

```text
/admin/integrations
```

Each provider follows the same general shape: register with the provider, then complete the connect flow at `/admin/integrations`. GitHub uses an in-app **manifest flow** that registers the App for you; Atlassian uses an OAuth app you create manually first.

### GitHub App

Project Brain registers its GitHub App through GitHub's manifest flow — you don't fill in permissions, URLs, or PEMs by hand. Credentials are stored encrypted on `platform_integrations` (AES-256-GCM via `BRAIN_MASTER_KEY`), not in `.env`.

**Prerequisites**

- A super_admin account in Project Brain (the first user with `INITIAL_SUPER_ADMIN_EMAIL` is auto-promoted on sign-in).
- A publicly-reachable `APP_URL` (e.g. `https://brain.acme.corp`). For local dev with `APP_URL=http://localhost:3000`, the manifest flow works but the webhook URL is omitted automatically; wire it up once you have a public domain.
- Admin rights on the GitHub org you want the App owned by — required to create an App under an org. Without org admin, register under your personal account first and transfer ownership later by re-registering.

**Steps**

1. Open `/admin/integrations` and locate the **GitHub** card.
2. Type your GitHub org slug into the input (e.g. `acme-corp`) and click **Configure App**. Leave blank to register under your personal account.
3. GitHub asks you to confirm the App name and permissions, then redirects back to Project Brain. The server exchanges the one-time `code` for the App's id, slug, client id/secret, webhook secret, and PEM private key — all encrypted and persisted.
4. The card now shows "app registered." Click **Install on org** to attach the App to the org whose repos Project Brain should access. GitHub redirects you back to `/api/github/setup` and the installation id is captured automatically.

The manifest declares:

| Permission | Level          |
| ---------- | -------------- |
| Contents   | Read and write |
| Metadata   | Read-only      |
| Issues     | Read-only      |

Project Brain deliberately does **not** request the `Administration` permission. It never creates or deletes repositories — that stays under your own org's repo-provisioning governance. You create the repo on GitHub yourself, install the App on it, and then connect it from the in-app **New project** flow (which only needs `Contents` to commit into the existing repo). Deleting a project in Project Brain removes only its database rows; the GitHub repo is always left intact.

> Each repo you connect must have a `main` branch with at least one commit — the simplest way is to tick **Add a README** when creating it on GitHub. Project Brain commits to `main` and can no longer auto-initialize an empty repo.

**Switching org / re-registering**

GitHub does not let you transfer App ownership. To move the App from your personal account to an org (or between orgs):

1. Delete the App on GitHub: App settings → **Advanced** → **Delete GitHub App**.
2. In Project Brain: `/admin/integrations` → **Remove GitHub App** (clears the encrypted credentials row).
3. Re-run the **Configure App** step, this time with the target org slug.

**Switching the installation target**

You can install one App on a different org without re-registering: click **Reconnect** on the card. GitHub redirects to the manage page for the current installation; from there you can uninstall and then reinstall on a different account via the same button. Note that today Project Brain tracks one installation per deployment — switching targets replaces, it doesn't add.

### Atlassian

Jira and Confluence share one Atlassian OAuth app. The client id and client secret are stored encrypted on `platform_oauth_apps` (AES-256-GCM via `BRAIN_MASTER_KEY`), not in `.env`.

1. Sign in to Project Brain as a super_admin and open `/admin/integrations`. The **Atlassian OAuth** card at the top shows the redirect URI to register on Atlassian — copy it.
2. Create an OAuth app at [https://developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/).
3. Enable **Authorization code grants (3LO)**.
4. Add scopes:

   ```text
   read:jira-work
   read:jira-user
   read:confluence-content.all
   read:confluence-space.summary
   read:confluence-user
   search:confluence
   offline_access
   ```

5. Paste the redirect URI from step 1 into the OAuth app's **Callback URL** field.
6. Back in Project Brain's **Atlassian OAuth** card, paste the OAuth app's **client id** and **client secret**, then **Save Atlassian OAuth**.
7. Click **Connect Jira** or **Connect Confluence** on the per-product cards. The standard three-leg OAuth flow runs and the resulting access/refresh tokens are stored encrypted on `platform_integrations`.

To rotate credentials: click **Remove Atlassian OAuth** on the card, repeat steps 6 onward with the new values.

## Verify the deployment

```bash
curl -fsS https://<your-domain>/api/health
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f web worker
```

`readiness=true` means the database is reachable and migrations are applied.

Point your monitoring tool at:

```text
https://<your-domain>/api/health
```

Alert if `readiness=false` for two consecutive minutes.

## Use your own TLS certificate

By default, Caddy gets a Let's Encrypt certificate with the HTTP-01 challenge. Use your own certificate when the deployment uses enterprise PKI, an internal CA, or cannot reach Let's Encrypt.

1. Place the certificate and key on the host:

   ```text
   ./certs/fullchain.pem
   ./certs/privkey.pem
   ```

   `fullchain.pem` must include the leaf and intermediate certificates. `privkey.pem` must be an unencrypted private key with mode `0600`.

2. Set this in `.env`:

   ```env
   TLS_DIRECTIVE=tls /certs/fullchain.pem /certs/privkey.pem
   ```

3. Restart Caddy:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy
   ```

Caddy reloads certificates when the files change. `APP_DOMAIN` must match the certificate Common Name or SAN.

## Air-gapped install

On a machine with internet access:

```bash
./scripts/airgap-bundle.sh v1.4.2
```

Move the generated archive to the air-gapped host, then run:

```bash
tar xzf project-brain-airgap-v1.4.2.tar.gz
cd project-brain-airgap-v1.4.2
docker load < images.tar
./scripts/install.sh
```

The bundle includes signed images, Compose files, install scripts, and `SHA256SUMS`.

## Logs and audit events

`web` and `worker` write structured JSON logs to stdout. Each line includes service metadata, time, level, component, and event payload.

Set log level in `.env`:

```env
LOG_LEVEL=info
```

Valid values are `trace`, `debug`, `info`, `warn`, `error`, and `fatal`.

:::tip
Use `debug` briefly during an incident. Avoid `trace` in production unless you need very high-volume diagnostics.
:::

The Docker `json-file` driver is the default log capture point. To ship logs to a SIEM, configure your Docker daemon or Compose override to use your platform driver, such as `awslogs`, `gelf`, `syslog`, `fluentd`, or `splunk`.

Privileged actions are recorded in two places:

- The `audit_log` table, visible at `/admin/audit`
- Structured stdout logs with `kind: "audit"`

Sensitive fields are redacted automatically, including `password`, `authorization`, `cookie`, `token`, `apiKey`, `secret`, `clientSecret`, `accessToken`, and `refreshToken`.

Add more keys with:

```env
LOG_REDACT=header,xApiToken
```

## Graphify sidecar egress

Knowledge graph builds run in `graphify-sidecar`, a non-root container that runs the Graphify CLI directly. The worker prepares the Git checkout and sends the sidecar only a prepared workspace path plus model settings; GitHub installation tokens stay in the worker.

The sidecar is attached only to an internal Compose network. It reaches its **model** through the router, which is joined to that same network and listed in the sidecar's `NO_PROXY` — it has to be, because squid denies private-IP destinations and a sibling container is exactly that. The router then makes the upstream provider call.

So the allowlist below **does not bound graph-builder LLM traffic**; the connector list on /admin/router does, one hop later. It still governs every other outbound request the sidecar makes, and the proxy refuses to start on an empty list:

```env
GRAPHIFY_SIDECAR_TOKEN=<32+ random chars>
GRAPHIFY_EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com,api.openai.com,api.anthropic.com
```

`GRAPHIFY_SIDECAR_TOKEN` is required: the worker refuses to dispatch a build without it and the sidecar rejects every request when it is unset. Generate it with `openssl rand -hex 32` and keep it distinct from `INTERNAL_SERVICE_TOKEN`.

`GRAPHIFY_EGRESS_ALLOWED_HOSTS` entries must be valid hostnames; the proxy validates each one at startup and exits if any entry is malformed. Subdomain matching uses a leading dot (e.g. `.acme.com`) — wildcards like `*.acme.com` are not supported by the proxy ACL.

Enterprise deployments that want to bound model traffic should do it on the router — connect only the approved gateway as a connector — rather than here.

Verify the boundary after install:

```bash
docker compose exec graphify-sidecar python -c "import urllib.request; urllib.request.urlopen('https://github.com', timeout=3)"
# expected: fails

docker compose exec graphify-sidecar python -c "import os,urllib.request; proxy=os.environ['HTTPS_PROXY']; print(proxy)"
```

## Knowledge graph builds

After every accepted change to a project's repo — and on a manual or scheduled rebuild — the worker hands the workspace to `graphify-sidecar`, which runs `graphify extract` to (re)build the knowledge graph.

`graphify extract` is **incremental**: it keeps a SHA-256 content-hash cache in `graphify-out/cache/`, so unchanged files cost no LLM calls. Changed files are re-extracted at LLM cost, so **every commit can trigger paid LLM usage** for the files it touches. Two best-effort post-steps then regenerate the human- and assistant-facing artifacts:

| Artifact                                     | Produced by             | Purpose                                            |
| -------------------------------------------- | ----------------------- | -------------------------------------------------- |
| `graphify-out/graph.json`                    | `graphify extract`      | The extracted knowledge graph (nodes + edges)      |
| `graphify-out/GRAPH_REPORT.md`, `graph.html` | `graphify cluster-only` | Human-readable community report + interactive view |
| `graphify-out/wiki/` (entry `wiki/index.md`) | `graphify export wiki`  | The assistant's primary grounding source           |

The post-steps are budget-gated and skipped if extraction already used its time budget; older builds may have only `GRAPH_REPORT.md` and no `wiki/`.

Tuning knobs are read by the sidecar from its own service environment (set them on the `graphify-sidecar` service):

```env
GRAPHIFY_TIMEOUT_S=1800              # overall extraction budget (default 30 min)
GRAPHIFY_CLUSTER_ONLY_TIMEOUT_S=900  # community naming + GRAPH_REPORT.md + graph.html (one model call per community)
GRAPHIFY_WIKI_TIMEOUT_S=120          # wiki export
GRAPHIFY_MAX_OUTPUT_TOKENS=32768     # per-call output token cap
```

### Forcing a full or fresh rebuild

The graph rebuilds incrementally by default. If the cache becomes stale or corrupt, force a full rebuild from the project UI: **hold Shift while clicking the Rebuild button**. This wipes `graphify-out/cache/` and re-extracts every file from scratch, at full LLM cost, so use it only for recovery, not routinely. A forced rebuild only clears the extraction cache; the existing `graph.json` and `GRAPH_REPORT.md` stay in place until the new build overwrites them.

A **fresh** rebuild goes one step further and wipes every graphify output first, so the graph is built from nothing. The project offers it automatically when a graph-shaping setting changed since the last build (the header shows "Settings changed since last build"). The API calls are:

```text
POST /api/projects/<slug>/graph/rebuild?mode=full
POST /api/projects/<slug>/graph/rebuild?mode=fresh
```

`?force=full` still works as an alias for `?mode=full`.

## Next steps

- [Upgrade Project Brain](UPGRADE.md)
- [Back up and restore](BACKUP.md)
- [Security model](security.md)
