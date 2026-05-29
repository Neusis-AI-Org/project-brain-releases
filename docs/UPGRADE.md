---
title: Upgrade Project Brain
sidebar_label: Upgrade
sidebar_position: 2
description: Roll Project Brain forward to a new release safely.
---

# Upgrade Project Brain

Project Brain uses immutable image tags. To upgrade, set `IMAGE_TAG` to the new version and restart the stack.

Use the upgrade script in production. It takes a database snapshot, updates the image tag, runs migrations, restarts services, and checks readiness.

Run upgrades from the public release checkout:

```bash
cd project-brain-releases
git pull --ff-only
```

## Run an upgrade

```bash
./scripts/upgrade.sh v1.5.0
```

Replace `v1.5.0` with the version you want to install.

## What the script does

1. Creates a pre-upgrade database snapshot:

   ```text
   ./backups/postgres/projectbrain-pre-upgrade-<timestamp>.sql.gz
   ```

2. Writes the new tag to `.env`:

   ```env
   IMAGE_TAG=v1.5.0
   ```

3. Verifies image signatures if `COSIGN_VERIFY=true` and `cosign` is installed.
4. Pulls `migrate`, `web`, `worker`, `graphify-sidecar`, and `graphify-egress-proxy` at the new tag.
5. Runs the one-shot `migrate` service.
6. Starts `web`, `worker`, `graphify-sidecar`, and `graphify-egress-proxy`.
7. Polls `/api/health` for up to two minutes.

The upgrade is healthy when `/api/health` returns `readiness=true`.

If readiness fails, the script exits non-zero and prints inspection commands.

## Enable image signature verification

Signature verification is recommended for production.

Install `cosign` once:

```bash
curl -sLO https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
sudo install -m 0755 cosign-linux-amd64 /usr/local/bin/cosign
```

Turn on verification:

```bash
sed -i 's|^COSIGN_VERIFY=.*|COSIGN_VERIFY=true|' .env
```

After this, `upgrade.sh` rejects images that were not signed by the official release workflow.

## Roll back

Schema migrations are forward-only. If a release includes a schema-breaking migration, you cannot safely roll back by changing `IMAGE_TAG` alone.

Use one of these paths:

| Path                  | When to use it                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Fix forward           | Preferred. Upgrade to the next patch release, such as `v1.5.1`.                            |
| Restore from snapshot | Use when you must return to the previous version. Data written after the snapshot is lost. |

To restore from the pre-upgrade snapshot:

```bash
sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=v1.4.2|' .env
./scripts/restore.sh ./backups/postgres/projectbrain-pre-upgrade-<timestamp>.sql.gz
```

The restore script drops and recreates the database, restores the snapshot, re-runs migrations defensively, and starts the old version.

:::warning
Restore only during a maintenance window. Any writes made between the snapshot and restore are lost.
:::

## Get release notifications

Project Brain does not auto-pull new images.

Use one of these notify-only options:

- Watch [project-brain-releases](https://github.com/Neusis-AI-Org/project-brain-releases/releases).
- Run [Diun](https://crazymax.dev/diun/) alongside the stack.

Do not allow an auto-pull tool to run migrations against a live database.

## Scale the web service

A deployment can run multiple `web` containers:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale web=3
```

Only one process may run the scheduler. The Compose files already set `SCHEDULER_ENABLED=true` only on `worker` and force it to `false` on `web`.

Do not scale `worker` above one instance unless you also split the queue topology. The BullMQ scheduler is designed to run as a single instance.
