#!/usr/bin/env bash
# Project Brain — customer-environment upgrade script.
#
# Usage:
#   scripts/upgrade.sh <image-tag>
#   scripts/upgrade.sh v1.4.2
#
# What it does:
#   1. Snapshots the database via pg_dump (the brain repo lives in the
#      customer's GitHub org, so only the DB needs backing up). The
#      postgres-backup sidecar also runs nightly — this is the pre-upgrade
#      snapshot specifically.
#   2. Optionally verifies the new images with cosign (set COSIGN_VERIFY=true
#      in .env to enable; requires the cosign binary on the host).
#   3. Pulls the requested tag for migrate + web + worker + graphify services.
#   4. Runs the one-shot `migrate` service. Compose blocks web/worker behind
#      `service_completed_successfully`, so a migration failure aborts the
#      rollout before any traffic hits the new code.
#   5. Brings web + worker + sidecar up with the new tag.
#   6. Polls /api/health until readiness=true (DB reachable, migrations
#      applied) or fails after 2 minutes.
#
# Auto-detects the prod overlay (docker-compose.prod.yml). If present, all
# compose invocations include it.
#
# Rollback: re-run with the prior tag. Forward-only migrations mean a
# schema-breaking upgrade needs a fix-forward release, not a downgrade —
# but the pre-upgrade snapshot in ./backups/ lets you restore via
# scripts/restore.sh as a last resort.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <image-tag>" >&2
  exit 2
fi

NEW_TAG="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f .env ]; then
  echo "error: .env not found in $REPO_ROOT — run scripts/install.sh first" >&2
  exit 1
fi

# Read .env into the environment so we can branch on COSIGN_VERIFY etc.
# Only export what we need; this file is shell-safe (no spaces in values).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Auto-detect the prod overlay.
COMPOSE_ARGS=(-f docker-compose.yml)
if [ -f docker-compose.prod.yml ]; then
  COMPOSE_ARGS+=(-f docker-compose.prod.yml)
fi

BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_DIR/projectbrain-pre-upgrade-$STAMP.sql.gz"

echo "==> [1/6] Snapshotting database → $BACKUP_FILE"
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres pg_dump -U brain projectbrain | gzip > "$BACKUP_FILE"

echo "==> [2/6] Pinning IMAGE_TAG=$NEW_TAG in .env"
if grep -q '^IMAGE_TAG=' .env; then
  tmp="$(mktemp)"
  sed "s|^IMAGE_TAG=.*|IMAGE_TAG=$NEW_TAG|" .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
else
  echo "IMAGE_TAG=$NEW_TAG" >> .env
fi

# Values sourced from .env are exported and take precedence over the updated
# file during this process. Keep Compose on the newly pinned tag immediately;
# otherwise the first upgrade attempt still pulls the previous release.
export IMAGE_TAG="$NEW_TAG"

# Cosign verification (optional). Verifies the four published images against
# the GitHub Actions OIDC issuer. Only runs if COSIGN_VERIFY=true and cosign
# is installed — otherwise warn and continue.
if [ "${COSIGN_VERIFY:-false}" = "true" ]; then
  if ! command -v cosign >/dev/null 2>&1; then
    echo "warning: COSIGN_VERIFY=true but cosign not installed — skipping signature check" >&2
  else
    echo "==> [2.5/6] Verifying image signatures (cosign keyless)"
    REGISTRY="${IMAGE_REGISTRY:-ghcr.io/neusis-ai-org}"
    OWNER_REPO="${COSIGN_OIDC_REPO:-Neusis-AI-Org/project-brain}"
    for image in web worker migrate graphify-sidecar graphify-egress-proxy; do
      cosign verify \
        --certificate-identity-regexp "^https://github.com/${OWNER_REPO}/.github/workflows/release\\.yml@" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        "$REGISTRY/project-brain-$image:$NEW_TAG" >/dev/null
      echo "    ok: $REGISTRY/project-brain-$image:$NEW_TAG"
    done
  fi
fi

echo "==> [3/6] Pulling images for tag $NEW_TAG"
docker compose "${COMPOSE_ARGS[@]}" pull migrate web worker graphify-sidecar graphify-egress-proxy

echo "==> [4/6] Running migrations"
docker compose "${COMPOSE_ARGS[@]}" run --rm migrate

echo "==> [5/6] Restarting web + worker + sidecar"
docker compose "${COMPOSE_ARGS[@]}" up -d web worker graphify-sidecar graphify-egress-proxy

echo "==> [6/6] Waiting for readiness (120s budget)"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  body="$(docker compose "${COMPOSE_ARGS[@]}" exec -T web wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  if echo "$body" | grep -q '"readiness":true'; then
    echo "==> Readiness confirmed."
    echo "$body"
    exit 0
  fi
  sleep 3
done

echo "error: readiness not reached within 120s. Inspect:" >&2
echo "  docker compose ${COMPOSE_ARGS[*]} logs --tail=200 web worker" >&2
echo "  docker compose ${COMPOSE_ARGS[*]} ps" >&2
exit 1
