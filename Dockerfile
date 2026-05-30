# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    npm cache clean --force

COPY server ./server
COPY public ./public

# Final stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY package.json package-lock.json ./

RUN addgroup -S poker && adduser -S poker -G poker \
 && chown -R poker:poker /app
USER poker

EXPOSE 3000

CMD ["node", "server/index.js"]
