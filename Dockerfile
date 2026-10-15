# InstaBOT — Render / any container host (Debian: canvas has prebuilt binaries, no compile needed)
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080

# Runtime libs for the prebuilt `canvas` binary + fonts + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
      fontconfig fonts-dejavu-core ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "index.js"]
