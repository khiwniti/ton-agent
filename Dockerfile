# ====================================================================
# 🐳 TON AGENT RUNTIME — multi-stage image (apps/agent only)
# The web app is deployed to Vercel and is NOT part of this image.
# ====================================================================

# --------------------------------------------------------------------
# Stage 1: builder — install deps + compile TypeScript
# --------------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Native build deps for better-sqlite3 (node-gyp). Present in the
# BUILDER ONLY — never shipped in the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so `npm install` layer caches well.
# NOTE: apps/web is intentionally excluded (see .dockerignore) so its
# dependencies never bloat the agent image.
COPY package.json package-lock.json* .npmrc ./
COPY apps/agent/package.json ./apps/agent/package.json
COPY packages/shared/package.json ./packages/shared/package.json

# Workspace install (Termux/Android peer-dep quirks → legacy resolver).
# Force-install @ston-fi/api since @ston-fi/sdk lists it as a peer dep
# and peer deps are not auto-installed with --legacy-peer-deps.
RUN npm install --legacy-peer-deps && \
    npm install @ston-fi/api@0.32.0 --legacy-peer-deps && \
    ls /app/node_modules/@ston-fi/ && \
    node -e "try { require('@ston-fi/api'); console.log('[BUILD] @ston-fi/api OK'); } catch(e) { console.log('[BUILD] @ston-fi/api FAIL:', e.message); }"

# Copy the sources needed to build the agent.
COPY apps/agent ./apps/agent
COPY packages/shared ./packages/shared

# Compile the agent runtime (tsc → apps/agent/dist).
RUN npm --workspace apps/agent run build

# Prune dev dependencies to slim what we carry into runtime.
# NOTE: @ston-fi/api is intentionally kept as a production dependency
# by virtue of being added to both root and workspace package.json.
RUN npm prune --omit=dev --legacy-peer-deps && \
    node -e "try { require('@ston-fi/api'); console.log('[BUILD] @ston-fi/api still OK after prune'); } catch(e) { console.log('[BUILD CRITICAL] @ston-fi/api PRUNED:', e.message); }"

# --------------------------------------------------------------------
# Stage 2: runtime — lean, non-root
# --------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data

# HEALTH_PORT is intentionally NOT baked into the image — it is supplied
# at runtime via docker-compose (compose sets HEALTH_PORT="9090") or via
# Railway's $PORT env var (the container falls back to process.env.PORT
# in index.ts). Keeping HEALTH_PORT out of the image ensures the auto-
# detection logic for Railway works without an explicit override.

# curl is required for the container HEALTHCHECK below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Bring over the compiled output, the workspace shared package (its
# symlink target), and the pruned production node_modules.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/agent/dist ./apps/agent/dist
COPY --from=builder /app/apps/agent/package.json ./apps/agent/package.json
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/package.json ./package.json

# Re-assert @ston-fi/api in runtime — it is a peer dependency of
# @ston-fi/sdk and may not survive the multi-stage COPY layer.
RUN ls /app/node_modules/@ston-fi/ 2>&1 && \
    node -e "try { require('@ston-fi/api'); console.log('[RUNTIME] @ston-fi/api available from build'); } catch(e) { console.log('[RUNTIME] @ston-fi/api missing, forcing install...'); }" && \
    (node -e "require('@ston-fi/api')" 2>/dev/null || npm install @ston-fi/api@0.32.0 --legacy-peer-deps --no-save) && \
    node -e "try { require('@ston-fi/api'); console.log('[RUNTIME] @ston-fi/api OK'); } catch(e) { console.log('[RUNTIME CRITICAL] @ston-fi/api FAIL:', e.message); }"

# SQLite lives here; mount a volume over it in production (see compose).
RUN mkdir -p /app/data && chown -R node:node /app

# Drop privileges.
USER node

# Health server (bound to loopback inside the container).
EXPOSE 9090

# Liveness: the agent exposes GET /healthz on HEALTH_PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9090/healthz || exit 1

# Startup diagnostic — verify @ston-fi/api availability before agent boot.
# The build confirms it's in the image, but runtime resolution may differ.
CMD node -e "\
  try {\
    var p = require.resolve('@ston-fi/api');\
    console.log('[STARTUP] @ston-fi/api resolved to:', p);\
  } catch(e) {\
    console.log('[STARTUP] @ston-fi/api RESOLVE FAIL:', e.message);\
    console.log('[STARTUP] Attempting fallback install...');\
    require('child_process').execSync('npm install @ston-fi/api@0.32.0 --legacy-peer-deps --no-save', { cwd: '/app' });\
    try {\
      p = require.resolve('@ston-fi/api');\
      console.log('[STARTUP] @ston-fi/api resolved after fallback to:', p);\
    } catch(e2) {\
      console.log('[STARTUP] @ston-fi/api STILL FAILS after fallback:', e2.message);\
    }\
  }\
  console.log('[STARTUP] Booting agent...');\
" && node apps/agent/dist/index.js
