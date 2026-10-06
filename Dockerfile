FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# The modules directory is expected to be mounted read-only at runtime,
# e.g. ./modules:/modules:ro — the interpreter only reads from it.
ENTRYPOINT ["node", "src/cli.js"]
CMD ["--help"]
