FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Copy dependency descriptors first to leverage Docker layer caching
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source code
COPY server.js ./
COPY public ./public

# Drop root privileges for runtime security
USER node

EXPOSE 3000

CMD ["node", "server.js"]
