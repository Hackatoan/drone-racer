# --- build: client bundle (vite) + server bundle (esbuild)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm test

# --- runtime: only production deps + dist
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3043
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3043
USER node
CMD ["node", "dist/server.js"]
