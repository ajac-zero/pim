# The egress proxy's image holds only the proxy and no build stamp, so rebuilding the stack for a
# new commit leaves it unchanged unless the proxy itself changed, and compose does not recreate the
# running proxy (which would cut every session's open connections).
FROM node:22-alpine AS egress-proxy
WORKDIR /app
COPY package.json ./
COPY src/proxy.js src/proxy-main.js ./src/
USER node
CMD ["node", "src/proxy-main.js"]

# The manager, the default target.
FROM node:22-alpine AS manager
ARG BUILD_SHA=unknown
WORKDIR /app
COPY package.json ./
COPY src ./src
# Snapshots and the cache index live here; compose mounts a named volume, which takes this owner.
RUN mkdir /data && chown node:node /data
ENV BUILD_SHA=$BUILD_SHA
USER node
CMD ["node", "src/main.js"]
