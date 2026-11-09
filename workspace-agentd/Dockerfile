# Minimal workspace image: the tools a coding agent needs, plus agentd as the entrypoint.
# Build from the repository root:  docker build -t pim-workspace workspace-agentd
FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ripgrep build-essential ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/*

# Node's image already has a uid 1000 user; agentd runs as uid 10001.
RUN groupadd --gid 10001 workspace \
	&& useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash workspace \
	&& mkdir -p /workspace /opt/agentd \
	&& chown workspace:workspace /workspace

COPY --chown=root:root *.mjs package.json /opt/agentd/

USER 10001:10001
WORKDIR /workspace
VOLUME /workspace
EXPOSE 8787
ENV AGENTD_ROOT=/workspace AGENTD_PORT=8787

# tini reaps the orphans that exec leaves behind. AGENTD_TOKEN must be provided at run time.
ENTRYPOINT ["tini", "--", "node", "/opt/agentd/server.mjs"]
