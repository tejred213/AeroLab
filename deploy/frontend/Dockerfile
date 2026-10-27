# AeroLab frontend: the Next.js app as a standalone Node server. Built from the repository root:
#
#     fly deploy . --config deploy/frontend/fly.toml --depot=false
#
# /api/* is forwarded to the backend (AEROLAB_BACKEND_INTERNAL_URL, fixed at build time), so the
# browser sees one origin and the session cookie is first-party.

FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG AEROLAB_BACKEND_INTERNAL_URL
ENV AEROLAB_STANDALONE=1 \
    AEROLAB_BACKEND_INTERNAL_URL=${AEROLAB_BACKEND_INTERNAL_URL} \
    NEXT_PUBLIC_AEROLAB_BACKEND_URL=/ \
    NEXT_PUBLIC_AEROLAB_HIDE_BACKEND_BADGE=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN test -n "$AEROLAB_BACKEND_INTERNAL_URL" && npm run build

FROM node:22.23.4-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
