FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# All module files are read from a directory mounted at /modules (read-only
# via the compose `:ro` flag). The image never writes to it.
ENTRYPOINT ["node", "src/cli.js"]
CMD ["/modules", "main.mjs", "--call", "main"]
