FROM ghcr.io/puppeteer/puppeteer:22.6.0

USER root

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data/.wwebjs_auth && \
    chown -R pptruser:pptruser /data /app

USER pptruser

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
