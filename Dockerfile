FROM node:22-slim
ENV NODE_ENV=production BOT_DATA_DIR=/var/data COOKIE_SECURE=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY bot.js dashboard.js ./
EXPOSE 10000
CMD ["npm", "start"]
