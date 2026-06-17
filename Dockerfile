# ---- Stage 1: build the React dashboard ----
FROM node:22-alpine AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---- Stage 2: production server ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY --from=webbuild /app/web/dist ./web/dist
EXPOSE 3000
USER node
CMD ["node", "src/index.js"]
