# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---- runtime ----
FROM node:20-bookworm-slim
WORKDIR /app
# ffmpeg-static ships a binary, but having system ffmpeg avoids edge-case codec issues
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY package.json ./
COPY prisma ./prisma
RUN npm install --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
# default command runs the API; the worker service overrides this in compose
CMD ["node", "dist/index.js"]
