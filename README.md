# Project Brain Releases

Public installer mirror for Project Brain.

Project Brain is distributed as signed container images plus Docker Compose
installer assets. The source repository is private; this repository contains
only the files required to install, upgrade, back up, and restore a customer
deployment.

## Install

```bash
git clone https://github.com/Neusis-AI-Org/project-brain-releases.git
cd project-brain-releases
./scripts/install.sh
```

The installer asks for your domain, initial super-admin email, LLM provider,
and image tag. Use `latest` for the current stable release or pin a specific
version such as `v1.4.2`.

## Upgrade

```bash
./scripts/upgrade.sh v1.5.0
```

See `docs/INSTALL.md`, `docs/UPGRADE.md`, and `docs/BACKUP.md` for operator
instructions, including air-gapped install bundles.

## Images

Published images are hosted on GitHub Container Registry:

```text
ghcr.io/neusis-ai-org/project-brain-web
ghcr.io/neusis-ai-org/project-brain-worker
ghcr.io/neusis-ai-org/project-brain-migrate
ghcr.io/neusis-ai-org/project-brain-graphify-sidecar
ghcr.io/neusis-ai-org/project-brain-graphify-egress-proxy
```
