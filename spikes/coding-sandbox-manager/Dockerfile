# One small image for both services; compose picks the entrypoint.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
CMD ["node", "src/main.js"]
