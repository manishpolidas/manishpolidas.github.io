# Build context is the otp-load-tester/ directory (npm workspace root).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install --workspaces --include-workspace-root --ignore-scripts
COPY server server
RUN npm run build --workspace=server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
RUN npm install --omit=dev --workspace=server --include-workspace-root --ignore-scripts \
    && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY server/db server/db

USER node
EXPOSE 4000
# Fails fast on a misconfiguration (exit 78) rather than starting unsafely.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
