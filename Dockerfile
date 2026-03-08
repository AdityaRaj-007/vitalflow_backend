# This is an example Dockerfile that builds a minimal container for running LK Agents
# For more information on the build process, see https://docs.livekit.io/agents/ops/deployment/builds/
# syntax=docker/dockerfile:1

# Use the official Node.js v22 base image with Node.js 22.10.0
# We use the slim variant to keep the image size smaller while still having essential tools
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

# Install required system packages and clean up the apt cache for a smaller image
# ca-certificates: enables TLS/SSL for securely fetching dependencies and calling HTTPS services
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Create a new directory for our application code
# And set it as the working directory
WORKDIR /app

# Copy just the dependency files first, for more efficient layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm install

# Copy all remaining application files into the container
COPY . .

# Build the project
RUN npm run build

# Create a non-privileged user that the app will run under
ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

# Set proper permissions
RUN chown -R appuser:appuser /app
USER appuser

# Pre-download ML model files the agent needs at runtime
RUN npm run download-files

# Switch back to root to remove dev dependencies and finalize setup
USER root
RUN npm prune --production && chown -R appuser:appuser /app
USER appuser

# Set Node.js to production mode
ENV NODE_ENV=production

# Run the agent
CMD [ "npm", "run", "start:agent" ]