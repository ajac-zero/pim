# Minimal workspace image: the tools a coding agent needs, the coding harness CLIs, plus agentd as the entrypoint.
# Build from the repository root:  docker build -t pim-workspace workspace-agentd

# Mistral Vibe's CLI, unmodified, for coding threads whose harness is `mistral-vibe` (docs/coding-vibe.md).
# Pinned: bump it on purpose, after checking `vibe --help`, its streaming output and export.json against
# src/coding/harness/vibe.ts. It needs Python 3.12 or later, which bookworm doesn't have, so uv (pinned too)
# installs it with a Python of its own, both under /opt/vibe, in a stage of its own: the image keeps
# /opt/vibe and not uv.
ARG UV_VERSION=0.12.9
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM node:22-bookworm-slim AS vibe
ARG VIBE_VERSION=3.1.0
COPY --from=uv /uv /usr/local/bin/uv
RUN UV_PYTHON_INSTALL_DIR=/opt/vibe/python UV_TOOL_DIR=/opt/vibe/tools UV_TOOL_BIN_DIR=/opt/vibe/bin \
	uv tool install --no-cache --compile-bytecode --managed-python --python 3.12 "mistral-vibe==${VIBE_VERSION}"

FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ripgrep build-essential ca-certificates tini procps time \
	&& rm -rf /var/lib/apt/lists/*

# pnpm, pinned to the repository's `packageManager` field, so large pnpm repositories build without corepack:
# corepack ignores the egress proxy, and /usr/local/bin is read-only at run time.
ARG PNPM_VERSION=12.0.0
RUN npm install -g "pnpm@${PNPM_VERSION}" \
	&& npm cache clean --force \
	&& pnpm --version

# Claude Code's CLI, unmodified, for coding threads whose harness is `claude-code` (docs/coding-claude-code.md).
# Pinned: bump the version on purpose, after checking its flags and stream-json against src/coding/harness/claude-code.ts.
# Its npm package installs the native binary for the platform from an optional dependency. procps (above) gives
# `pkill`, which Pim interrupts a turn with.
ARG CLAUDE_CODE_VERSION=2.1.311
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
	&& npm cache clean --force \
	&& claude --version

# OpenAI's Codex CLI, unmodified, for coding threads whose harness is `codex` (docs/coding-codex.md).
# Pinned the same way: bump it on purpose, after checking `codex exec --help` and its JSONL against
# src/coding/harness/codex.ts. Its npm package also installs the platform's native binary from an
# optional dependency.
ARG CODEX_VERSION=0.167.0
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
	&& npm cache clean --force \
	&& codex --version

# Amp's CLI, unmodified, for coding threads whose harness is `amp` (docs/coding-amp.md). Pinned the same way: bump it
# on purpose, after checking `amp --help`, the managed settings below and its stream-json against
# src/coding/harness/amp.ts. `@ampcode/cli` (once `@sourcegraph/amp`) installs the platform's native binary from an
# optional dependency. The managed settings are the one settings file a repository's `.amp/settings.json` can't
# override: no MCP server starts, no updates, no confirmations nobody could answer, and no web tools that would fetch
# from Amp's servers past the workspace's egress allowlist.
ARG AMP_VERSION=0.0.1794240032-ga42e06
COPY amp-managed-settings.json /etc/ampcode/managed-settings.json
RUN npm install -g "@ampcode/cli@${AMP_VERSION}" \
	&& npm cache clean --force \
	&& amp --version

# Mistral Vibe, from its stage above, at the same path: its scripts name their Python by it.
COPY --from=vibe /opt/vibe /opt/vibe
RUN ln -s /opt/vibe/bin/vibe /usr/local/bin/vibe \
	&& vibe --version

# Node's image already has a uid 1000 user; agentd runs as uid 10001.
RUN groupadd --gid 10001 workspace \
	&& useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash workspace \
	&& mkdir -p /workspace /opt/agentd \
	&& chown workspace:workspace /workspace

# A global prefix the runtime user can write, so `npm install -g` works at run time; the pinned CLIs above stay in /usr/local/bin.
RUN mkdir -p /home/workspace/.npm-global && chown 10001:10001 /home/workspace/.npm-global
ENV NPM_CONFIG_PREFIX=/home/workspace/.npm-global PATH=/home/workspace/.npm-global/bin:$PATH

COPY --chown=root:root *.mjs package.json /opt/agentd/

USER 10001:10001
WORKDIR /workspace
VOLUME /workspace
EXPOSE 8787
ENV AGENTD_ROOT=/workspace AGENTD_PORT=8787

# tini reaps the orphans that exec leaves behind. AGENTD_TOKEN must be provided at run time.
ENTRYPOINT ["tini", "--", "node", "/opt/agentd/server.mjs"]
