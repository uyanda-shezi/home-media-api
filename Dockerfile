# ==========================================
# Stage 1: Build & Prune
# ==========================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# Copy build configs and source files
COPY tsconfig*.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/

# Compile TypeScript to dist/
RUN npm run build

# Prune devDependencies, leaving only production dependencies
RUN npm prune --omit=dev

# ==========================================
# Stage 2: Production Minimal Runtime
# ==========================================
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/home-media.db

# Ensure persistent directories exist and are owned by non-root node user (uid: 1000)
RUN mkdir -p /app/data /app/backups && \
    chown -R node:node /app

# Copy production artifacts from builder stage
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/migrations ./migrations

# Declare persistence volumes for SQLite database (including WAL) and backups
VOLUME ["/app/data", "/app/backups"]

# Drop root privileges
USER node

# Expose API port
EXPOSE 3000

# Zero-dependency healthcheck via Node 22 native fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the application with signal handling
CMD ["node", "dist/index.js"]
