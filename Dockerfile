FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

CMD ["node", "cron.js"]
