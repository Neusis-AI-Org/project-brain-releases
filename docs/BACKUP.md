---
title: Backup and Restore
sidebar_label: Backup
sidebar_position: 3
description: Back up, restore, and test Project Brain production data.
---

# Backup and restore

The production overlay runs two backup sidecars automatically.

| Sidecar            | What it backs up                           | Destination            | Default retention            |
| ------------------ | ------------------------------------------ | ---------------------- | ---------------------------- |
| `postgres-backup`  | The `projectbrain` database with `pg_dump` | `./backups/postgres/`  | 7 daily, 4 weekly, 6 monthly |
| `workspace-backup` | Graphify workspace volume                  | `./backups/workspace/` | 14 days                      |

No host cron job is needed for local backups. The sidecars start with:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Backup locations

```text
./backups/
+-- postgres/
|   +-- daily/
|   +-- weekly/
|   +-- monthly/
|   +-- projectbrain-pre-upgrade-*.sql.gz
+-- workspace/
    +-- workspace-2026-04-29T03-00-00.tar.gz
```

The `./backups/` directory is mode `0700` and owned by the user running Compose.

Database dumps are gzipped and are usually much smaller than the live database.

## Copy backups off host

Local backups are not enough. Sync `./backups/` to durable storage on a schedule.

Choose one option:

```bash
# AWS S3
aws s3 sync ./backups/ s3://acme-projectbrain-backups/$(hostname)/

# Google Cloud Storage
gsutil -m rsync -r ./backups/ gs://acme-projectbrain-backups/$(hostname)/

# Azure Blob
az storage blob sync --account-name acmeprojectbrain --container backups --source ./backups/

# rclone: S3, B2, R2, OneDrive, and others
rclone sync ./backups/ remote:projectbrain-backups
```

Run the sync after the local backup, for example at `03:30`:

```text
30 3 * * *
```

## Restore the database

Use `scripts/restore.sh` for database restores. It stops app services, rebuilds the database, restores the dump, runs migrations defensively, and starts the app again.

```bash
./scripts/restore.sh ./backups/postgres/daily/projectbrain-2026-04-29.sql.gz
```

The script asks you to type `restore` before it changes data.

For automation:

```bash
RESTORE_ASSUME_YES=true ./scripts/restore.sh ./backups/postgres/daily/projectbrain-2026-04-29.sql.gz
```

:::warning
Restores are in-place and destructive. The current database is dropped and recreated.
:::

Expected downtime is 1-5 minutes for small instances and longer for large dumps.

## Restore the workspace volume

The workspace contains shallow Git clones and graphify artifacts. Losing it does not lose product data, but the next graph rebuild starts cold. The worker scrubs the authenticated GitHub remote before each graphify run and verifies the scrub by re-reading `origin`; a run that cannot verify the scrub aborts before any data leaves the worker, so a snapshot of an idle workspace volume should not contain live GitHub installation tokens. (A snapshot taken mid-build can briefly include one, and installation tokens expire one hour after issuance regardless.)

Restore it only if you want to avoid the cold-start cost.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop worker graphify-sidecar graphify-egress-proxy

docker run --rm \
  -v project-brain_graphify_workspace:/workspace \
  -v "$PWD/backups/workspace:/archive:ro" \
  alpine sh -c 'cd /workspace && tar -xzf /archive/workspace-<timestamp>.tar.gz --strip-components=1'

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d worker graphify-sidecar graphify-egress-proxy
```

Replace:

- `<timestamp>` with the snapshot timestamp
- `project-brain_graphify_workspace` with the volume name from `docker volume ls`

## Run a restore drill

:::tip
A backup is only useful after you have proven it restores.
:::

Run this once before launch, then quarterly:

1. Create a clean staging VM.
2. Run `./scripts/install.sh` with throwaway secrets.
3. Copy a recent production backup to staging.
4. Run `./scripts/restore.sh <path>`.
5. Sign in and verify expected data exists.
6. Destroy the staging VM.

If the drill fails, fix the restore path before relying on the backup.

## Disable backup sidecars

If your platform already handles backups, such as Velero, pgBackRest, or managed Postgres backups, remove the sidecars from the production overlay or override them with a third Compose file.

`scripts/upgrade.sh` still creates a pre-upgrade database snapshot even when the sidecars are disabled.

## Not backed up

| Data                      | Reason                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Redis                     | BullMQ queues can be rebuilt. In-flight jobs may re-run.                                                    |
| Caddy data volume         | Caddy can re-issue certificates on startup.                                                                 |
| Customer Git repositories | Source code remains in the customer GitHub organization. Project Brain stores pointers and derived context. |
