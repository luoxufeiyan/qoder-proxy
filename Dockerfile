FROM node:20-slim

ENV PATH="/usr/local/bin:${PATH}"

# Install BOTH Qoder CLIs so a single image serves both editions:
#   - global edition: @qoder-ai/qodercli      -> binary `qodercli`   (auth: QODER_PERSONAL_ACCESS_TOKEN)
#   - CN edition:     @qodercn-ai/qoderclicn  -> binary `qoderclicn` (auth: QODERCN_PERSONAL_ACCESS_TOKEN)
# Which one is used at runtime is selected by the optional QODER_CLI=cn|global
# env var (default: global) — see src/config.js + src/helpers/spawn.js.
# NOTE: QODERCLI_BIN is intentionally NOT baked into the image. It remains a
# user-level override; global mode resolves /usr/local/bin/qodercli via the
# candidate probing already present in getQoderCliCommand().
# node:20-slim is Debian-based (glibc) which is required by both CLIs' Bun runtime.
# Alpine (musl libc) is incompatible with Bun native binaries.
RUN npm install -g @qoder-ai/qodercli @qodercn-ai/qoderclicn \
  && qodercli --version \
  && qoderclicn --version

# Disable auto-updates for BOTH editions so neither tries to download a new
# version on startup inside the container (saves memory, eliminates
# update-induced delays).
RUN mkdir -p /root/.qoder \
  && echo '{"autoUpdates":false}' > /root/.qoder.json \
  && echo '{"autoUpdates":false}' > /root/.qoder-cn.json

WORKDIR /app

# Install production deps first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

EXPOSE 3000

ENV NODE_ENV=production

# Use a Node.js health check — no wget/curl needed, works on any base image
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',_=>process.exit(1))"

CMD ["node", "src/server.js"]
