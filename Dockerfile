# Multi-stage build for teacher-playground
# Compiles the better-sqlite3 native module in the deps stage

# Stage 1: Dependencies and native module compilation
FROM node:20-bookworm-slim AS deps

WORKDIR /build

# Build toolchain for better-sqlite3 when no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Stage 2: Build Next.js application
FROM node:20-bookworm-slim AS build

WORKDIR /build

# Copy node_modules from deps stage
COPY --from=deps /build/node_modules ./node_modules

# Copy source and configuration
COPY package*.json ./
COPY next.config.js ./
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build Next.js
RUN npm run build

# Stage 3: Runtime image with minimal dependencies
FROM node:20-bookworm-slim

WORKDIR /app

# The node:20 images already provide a non-root `node` user at uid 1000.
# .data is created here so the container can start before a bind mount exists.
RUN mkdir -p /app/.data && chown -R node:node /app

# Copy built artifacts and dependencies from build stage
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/.next ./.next
COPY --from=build --chown=node:node /build/public ./public
COPY --from=build --chown=node:node /build/src ./src

# Copy configuration files
COPY --chown=node:node package.json ./
COPY --chown=node:node next.config.js ./
COPY --chown=node:node server.js ./

# Switch to non-root user
USER node

ENV NODE_ENV=production

EXPOSE 3000

# .data directory must be bind-mounted at runtime to persist SQLite data
# Example: docker run -v /srv/teacher-playground/data:/app/.data ...
CMD ["node", "server.js"]
