# syntax=docker/dockerfile:1.7

# Opt-in plugin dependencies at build time (space- or comma-separated directory names).
# Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,matrix" .
#
# Multi-stage build produces a minimal runtime image without build tools,
# source code, or Bun. Works with Docker, Buildx, and Podman.
# The ext-deps stage extracts only the package.json files we need from the
# bundled plugin workspace tree, so the main build layer is not invalidated by
# unrelated plugin source changes.
#
# Build stages use full bookworm; the runtime image is always bookworm-slim.
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_BUNDLED_PLUGIN_DIR=extensions
ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST="sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"
# Keep in sync with .github/actions/setup-node-env/action.yml bun-version.
# To update: docker buildx imagetools inspect oven/bun:<version> and use the manifest-list digest.
ARG OPENCLAW_BUN_IMAGE="oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"

# Base images are pinned to SHA256 digests for reproducible builds.
# Dependabot refreshes these blessed digests; release builds consume the
# reviewed base snapshot instead of mutating distro state on every build.
# To update, run: docker buildx imagetools inspect node:24-bookworm and
# node:24-bookworm-slim (or podman) and replace the digests below with the
# current multi-arch manifest list entries.

FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS ext-deps
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# Copy package.json for opted-in extensions so pnpm resolves their deps.
RUN --mount=type=bind,source=${OPENCLAW_BUNDLED_PLUGIN_DIR},target=/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR},readonly \
    mkdir -p /out && \
    for ext in $(printf '%s\n' "$OPENCLAW_EXTENSIONS" | tr ',' ' '); do \
      if [ -f "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then \
        mkdir -p "/out/$ext" && \
        cp "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" "/out/$ext/package.json"; \
      fi; \
    done

# ── Stage 2: Build ──────────────────────────────────────────────
FROM ${OPENCLAW_BUN_IMAGE} AS bun-binary
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

# Copy pinned Bun binary from the official image instead of fetching via curl.
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY openclaw.mjs ./
COPY proxy_fix.ts ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/npm-runner.mjs scripts/windows-cmd-helpers.mjs ./scripts/
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs

COPY --from=ext-deps /out/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/

# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

# pnpm v10+ may append peer-resolution hashes to virtual-store folder names; do not hardcode `.pnpm/...`
# paths. Matrix's native downloader can hit transient release CDN errors while
# still exiting successfully, so retry the package downloader before failing.
RUN set -eux; \
    echo "==> Verifying critical native addons..."; \
    for attempt in 1 2 3 4 5; do \
      if find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q .; then \
        exit 0; \
      fi; \
      echo "matrix-sdk-crypto native addon missing; retrying download (${attempt}/5)"; \
      node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js || true; \
      sleep $((attempt * 2)); \
    done; \
    find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q . || \
      (echo "ERROR: matrix-sdk-crypto native addon missing after retries" >&2 && exit 1)

COPY . .

# Normalize extension paths now so runtime COPY preserves safe modes
# without adding a second full extensions layer.
RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done

# A2UI bundle may fail under QEMU cross-compilation (e.g. building amd64
# on Apple Silicon). CI builds natively per-arch so this is a no-op there.
# Stub it so local cross-arch builds still succeed.
RUN pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p src/canvas-host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > src/canvas-host/a2ui/a2ui.bundle.js && \
     echo "stub" > src/canvas-host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
RUN pnpm build:docker
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build
RUN pnpm qa:lab:build

# Prune dev dependencies and strip build-only metadata before copying
# runtime assets into the final image.
FROM build AS runtime-assets
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# Keep the install layer frozen, but allow prune to run against the full copied
# workspace tree subset used during `pnpm install`. The build stage only copied
# the root, `ui`, and opted-in plugin manifests into the install layer, so
# prune must not rediscover unrelated workspaces from the later full source
# copy.
RUN printf 'packages:\n  - .\n  - ui\n' > /tmp/pnpm-workspace.runtime.yaml && \
    for ext in $(printf '%s\n' "$OPENCLAW_EXTENSIONS" | tr ',' ' '); do \
      printf '  - %s/%s\n' "$OPENCLAW_BUNDLED_PLUGIN_DIR" "$ext" >> /tmp/pnpm-workspace.runtime.yaml; \
    done && \
    cp /tmp/pnpm-workspace.runtime.yaml pnpm-workspace.yaml && \
    CI=true NPM_CONFIG_FROZEN_LOCKFILE=false pnpm prune --prod && \
    node scripts/postinstall-bundled-plugins.mjs && \
    OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" node scripts/prune-docker-plugin-dist.mjs && \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete && \
    node scripts/check-package-dist-imports.mjs /app

# ── Runtime base image ──────────────────────────────────────────
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS base-runtime
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-bookworm"

# ── Stage 3: Runtime ────────────────────────────────────────────
FROM base-runtime
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

# OCI base-image metadata for downstream image consumers.
# If you change these annotations, also update:
# - docs/install/docker.md ("Base image metadata" section)
# - https://docs.openclaw.ai/install/docker
LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.url="https://openclaw.ai" \
  org.opencontainers.image.documentation="https://docs.openclaw.ai/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="OpenClaw" \
  org.opencontainers.image.description="OpenClaw gateway and CLI runtime container image"

WORKDIR /app

# Install runtime system utilities missing from bookworm-slim.
# `ca-certificates` ships in `bookworm` (full) but not in `bookworm-slim`,
# so it must be installed explicitly here. Without it `/etc/ssl/certs/`
# stays empty and every HTTPS outbound dies at TLS handshake with
# `error setting certificate file`.
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates procps hostname curl git lsof openssl python3 socat maven && \
    update-ca-certificates

# Install document processing tools (PDF, DOC/DOCX, XLS/XLSX, PPTX, OCR, images).
# Used by skills/extensions for extracting text, converting formats and OCR.
# Adds ~650 MB to the runtime image (libreoffice dominates).
# fonts-noto-core is required for Cyrillic glyphs in headless LibreOffice rendering.
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      poppler-utils ghostscript qpdf \
      pandoc \
      antiword catdoc \
      gnumeric \
      tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
      imagemagick \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      fonts-liberation fonts-dejavu fonts-noto-core

# Install Go (pinned tarball; apt's golang is too old for some toolchains).
RUN curl -sL -o /tmp/go.tar.gz https://go.dev/dl/go1.23.6.linux-amd64.tar.gz \
 && echo "9379441ea310de000f33a4dc767bd966e72ab2826270e038e78b2c53c2e7802d  /tmp/go.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/go.tar.gz -C /usr/local \
 && rm -f /tmp/go.tar.gz

# Install JDK 21 (Eclipse Temurin). Maven (apt) pulls a default JRE that we
# shadow via JAVA_HOME so `mvn` runs on Temurin 21.
RUN curl -sL -o /tmp/jdk21.tar.gz https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_x64_linux_hotspot_21.0.11_10.tar.gz \
 && echo "4b2220e232a97997b436ca6ab15cbf70171ecff52958a46159dfa5a8c44ca4de  /tmp/jdk21.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/jdk21.tar.gz -C /usr/local \
 && rm -f /tmp/jdk21.tar.gz

ENV JAVA_HOME="/usr/local/jdk-21.0.11+10"
ENV PATH="$JAVA_HOME/bin:/usr/local/go/bin:$PATH"

RUN chown node:node /app

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/patches ./patches
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
COPY --from=runtime-assets --chown=node:node /app/proxy_fix.ts .
COPY --from=runtime-assets --chown=node:node /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} ./${OPENCLAW_BUNDLED_PLUGIN_DIR}
COPY --from=runtime-assets --chown=node:node /app/skills ./skills
COPY --from=runtime-assets --chown=node:node /app/docs ./docs
COPY --from=runtime-assets --chown=node:node /app/qa ./qa

# Keep pnpm available in the runtime image for container-local workflows.
# Use a shared Corepack home so the non-root `node` user does not need a
# first-run network fetch when invoking pnpm.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN install -d -m 0755 "$COREPACK_HOME" && \
    corepack enable && \
    for attempt in 1 2 3 4 5; do \
      if corepack prepare "$(node -p "require('./package.json').packageManager")" --activate; then \
        break; \
      fi; \
      if [ "$attempt" -eq 5 ]; then \
        exit 1; \
      fi; \
      sleep $((attempt * 2)); \
    done && \
    chmod -R a+rX "$COREPACK_HOME"

# Install additional system packages needed by your skills or extensions.
# Example: docker build --build-arg OPENCLAW_DOCKER_APT_PACKAGES="python3 wget" .
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES; \
    fi

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after node_modules COPY so playwright-core is available.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright; \
    fi

# Optionally install Docker CLI for sandbox container management.
# Build with: docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 ...
# Adds ~50MB. Only the CLI is installed — no Docker daemon.
# Required for agents.defaults.sandbox to function in Docker deployments.
ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
#RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
#    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
#    if [ -n "$OPENCLAW_INSTALL_DOCKER_CLI" ]; then \
#      apt-get update && \
#      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
#        ca-certificates curl gnupg && \
#      install -m 0755 -d /etc/apt/keyrings && \
#      # Verify Docker apt signing key fingerprint before trusting it as a root key.
#      # Require exactly one primary key (`pub` in --with-colons; subkeys use `sub`) so we
#      # never pin the first fingerprint while apt trusts extra keys from the same file.
#      # Update OPENCLAW_DOCKER_GPG_FINGERPRINT when Docker rotates release keys.
#      curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc && \
#      expected_fingerprint="$(printf '%s' "$OPENCLAW_DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" && \
#      docker_gpg_pub_count="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "pub" { c++ } END { print c+0 }')" && \
#      if [ "$docker_gpg_pub_count" != "1" ]; then \
#        echo "ERROR: Docker apt key must contain exactly one public key (found $docker_gpg_pub_count); refusing a multi-key file." >&2; \
#        exit 1; \
#      fi && \
#      actual_fingerprint="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" && \
#      if [ -z "$actual_fingerprint" ] || [ "$actual_fingerprint" != "$expected_fingerprint" ]; then \
#        echo "ERROR: Docker apt key fingerprint mismatch (expected $expected_fingerprint, got ${actual_fingerprint:-<empty>})" >&2; \
#        exit 1; \
#      fi && \
#      gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc && \
#      rm -f /tmp/docker.gpg.asc && \
#      chmod a+r /etc/apt/keyrings/docker.gpg && \
#      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
#        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list && \
#      apt-get update && \
#      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
#        docker-ce-cli docker-compose-plugin; \
#    fi

# Optionally install the full Docker stack (daemon + CLI + buildx + compose)
# for running Docker inside this container under `runtime: sysbox-runc`.
# Defaults to OFF so normal Docker deployments use the standard runtime without
# a nested daemon. Opt in with docker-compose.sysbox.yml or pair
# --build-arg OPENCLAW_ENABLE_INNER_DOCKER=1 with a compatible outer runtime.
# Adds ~250MB to the image.
#
# Docker CE/CLI and containerd.io are pinned to the newest tuple already proven
# under Sysbox 0.6.7; containerd.io 1.7.28 ships runc 1.3.0. runc >=1.3.3/1.2.8
# hardened sysctl writes via a safe-procfs API that rejects sysbox's FUSE-
# emulated /proc/sys with "unsafe procfs detected", which breaks every inner
# container (Docker sets net.ipv4.ip_unprivileged_port_start on all of them).
# Un-pin once sysbox supports the newer runc: nestybox/sysbox#973.
ARG OPENCLAW_ENABLE_INNER_DOCKER=""
ARG OPENCLAW_INNER_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_ENABLE_INNER_DOCKER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg sudo iptables uidmap && \
      install -m 0755 -d /etc/apt/keyrings && \
      curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc && \
      expected_fingerprint="$(printf '%s' "$OPENCLAW_INNER_DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" && \
      pub_count="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "pub" { c++ } END { print c+0 }')" && \
      if [ "$pub_count" != "1" ]; then \
        echo "ERROR: Docker apt key must contain exactly one public key (found $pub_count)" >&2; exit 1; \
      fi && \
      actual_fingerprint="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" && \
      if [ "$actual_fingerprint" != "$expected_fingerprint" ]; then \
        echo "ERROR: Docker apt key fingerprint mismatch (expected $expected_fingerprint, got ${actual_fingerprint:-<empty>})" >&2; exit 1; \
      fi && \
      gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc && \
      rm -f /tmp/docker.gpg.asc && \
      chmod a+r /etc/apt/keyrings/docker.gpg && \
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list && \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker-ce=5:29.5.3-1~debian.12~bookworm \
        docker-ce-cli=5:29.5.3-1~debian.12~bookworm \
        containerd.io=1.7.28-1~debian.12~bookworm \
        docker-buildx-plugin docker-compose-plugin && \
      apt-mark hold containerd.io && \
      groupadd -f docker && usermod -aG docker node && \
      printf 'Defaults:node env_keep += "HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy"\nnode ALL=(root) NOPASSWD: /usr/bin/dockerd\n' > /etc/sudoers.d/openclaw-dockerd && \
      chmod 0440 /etc/sudoers.d/openclaw-dockerd && \
      visudo -cf /etc/sudoers.d/openclaw-dockerd; \
    fi

# Entrypoint wraps the CMD: if dockerd is installed, start it (as root via
# sudo NOPASSWD), wait for the socket, then exec the main command as the
# current user (node). No-op when Docker isn't installed.
COPY --chmod=0755 <<'OPENCLAW_ENTRYPOINT_EOF' /usr/local/bin/openclaw-entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail

if command -v dockerd >/dev/null 2>&1 \
   && sudo -n -l /usr/bin/dockerd >/dev/null 2>&1 \
   && [[ ! -S /var/run/docker.sock ]]; then
  # node may run only /usr/bin/dockerd as root (narrow openclaw-dockerd sudoers
  # rule); invoke it directly. Backgrounding and the log redirect run in this
  # unprivileged node shell, so no extra sudo grants (sh/true/tail) are needed.
  sudo -n /usr/bin/dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do
    [[ -S /var/run/docker.sock ]] && break
    sleep 1
  done
  if [[ ! -S /var/run/docker.sock ]]; then
    echo "[openclaw-entrypoint] dockerd failed to start; tail of /tmp/dockerd.log:" >&2
    tail -n 50 /tmp/dockerd.log >&2 2>/dev/null || true
  fi
fi

exec "$@"
OPENCLAW_ENTRYPOINT_EOF

ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint.sh"]

# Expose the CLI binary without requiring npm global writes as non-root.
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

# Pre-create the default state dir so first-run Docker named volumes mounted
# here inherit node ownership instead of root-owned state.
RUN install -d -m 0700 -o node -g node /home/node/.openclaw && \
    stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700'

ENV NODE_ENV=production

# Security hardening: Run as non-root user
# The node:24-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# IMPORTANT: With Docker bridge networking (-p 18789:18789), loopback bind
# makes the gateway unreachable from the host. Either:
#   - Use --network host, OR
#   - Override --bind to "lan" (0.0.0.0) and set auth credentials
#
# Built-in probe endpoints for container health checks:
#   - GET /healthz (liveness) and GET /readyz (readiness)
#   - aliases: /health and /ready
# For external access from host/ingress, override bind to "lan" and set auth.
HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
