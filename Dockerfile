FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN addgroup -S poker && adduser -S poker -G poker \
 && chown -R poker:poker /app
USER poker

EXPOSE 3000

CMD ["node", "server/index.js"]
