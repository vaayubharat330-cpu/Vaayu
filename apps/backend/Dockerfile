# Production image for the VAAYU backend.
# Secrets are supplied at runtime through environment variables, never baked into the image.
# Build from apps/backend:  docker build -t vaayu-backend .
#
# The image serves public/ as it is in the repository. Portal bundles are rebuilt from portal-src/
# only after that source is verified against the live bundles (see PRODUCT_ISSUES.md, O2).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    PERSISTENCE_PROVIDER=postgres
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/private_uploads && chown -R node:node /app/private_uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "src/server_production.js"]
