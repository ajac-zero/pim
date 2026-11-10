# One small image for both services; compose picks the entrypoint.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
# Snapshots and the cache index live here; compose mounts a named volume, which takes this owner.
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "src/main.js"]
