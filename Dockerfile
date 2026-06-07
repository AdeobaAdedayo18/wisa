FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# Copy static admin assets (HTML dashboard) into the compiled output
RUN mkdir -p dist/admin && cp src/admin/dashboard.html dist/admin/dashboard.html

# Copy Prisma schema for migrate deploy
COPY prisma ./prisma

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
