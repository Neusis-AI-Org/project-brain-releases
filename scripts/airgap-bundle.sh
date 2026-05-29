#!/usr/bin/env bash
# Project Brain — build an air-gapped install bundle.
#
# Produces a single tarball containing:
#   - All five images at the requested tag (web, worker, migrate, graphify sidecar/proxy)
#   - docker-compose.yml + docker-compose.prod.yml + Caddyfile
#   - install.sh, upgrade.sh, restore.sh
#   - .env.example
#   - SHA256SUMS + MANIFEST.txt
#
# The customer then transfers the bundle to the air-gapped host, untars,
# `docker load < images.tar`, and runs install.sh.
#
# Usage:
#   scripts/airgap-bundle.sh v1.4.2 [output-dir]
#
# Requires: docker, tar, sha256sum (or `shasum -a 256`).
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <image-tag> [output-dir]" >&2
  exit 2
fi

TAG="$1"
OUT_DIR="${2:-./airgap-bundles}"
REGISTRY="${IMAGE_REGISTRY:-ghcr.io/neusis-ai-org}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p "$OUT_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUNDLE_NAME="project-brain-airgap-$TAG"
STAGE="$WORK/$BUNDLE_NAME"
mkdir -p "$STAGE"

IMAGES=(
  "$REGISTRY/project-brain-web:$TAG"
  "$REGISTRY/project-brain-worker:$TAG"
  "$REGISTRY/project-brain-migrate:$TAG"
  "$REGISTRY/project-brain-graphify-sidecar:$TAG"
  "$REGISTRY/project-brain-graphify-egress-proxy:$TAG"
)

echo "==> [1/4] Pulling $TAG"
for img in "${IMAGES[@]}"; do
  docker pull "$img"
done

echo "==> [2/4] docker save → images.tar (this can be large)"
docker save -o "$STAGE/images.tar" "${IMAGES[@]}"

echo "==> [3/4] Staging compose + scripts + docs"
cp docker-compose.yml docker-compose.prod.yml Caddyfile .env.example "$STAGE/"
mkdir -p "$STAGE/scripts" "$STAGE/docker"
cp scripts/install.sh scripts/upgrade.sh scripts/restore.sh "$STAGE/scripts/"
chmod +x "$STAGE/scripts/"*.sh
# Copy the docs the customer will actually need on the air-gapped host.
for doc in INSTALL.md UPGRADE.md BACKUP.md; do
  [ -f "docs/$doc" ] && cp "docs/$doc" "$STAGE/" || true
done

cat > "$STAGE/MANIFEST.txt" <<EOF
Project Brain air-gapped bundle
Tag:       $TAG
Registry:  $REGISTRY
Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Contents:
  images.tar             docker save of all 5 images
  docker-compose.yml     base stack
  docker-compose.prod.yml prod overlay (Caddy + backups)
  Caddyfile              auto-TLS reverse proxy
  .env.example           configuration template
  scripts/install.sh     interactive bootstrap
  scripts/upgrade.sh     upgrade flow
  scripts/restore.sh     restore from backup

Air-gapped install:
  1. Transfer this directory to the target host.
  2. cd into it.
  3. docker load < images.tar
  4. ./scripts/install.sh
EOF

echo "==> [4/4] Computing SHA256SUMS"
( cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

ARCHIVE="$OUT_DIR/$BUNDLE_NAME.tar.gz"
( cd "$WORK" && tar -czf "$ARCHIVE" "$BUNDLE_NAME" )

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo
echo "Bundle ready: $ARCHIVE  ($SIZE)"
echo "SHA256:       $(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
