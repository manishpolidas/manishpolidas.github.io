# Build context is the otp-load-tester/ directory (npm workspace root).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install --workspaces --include-workspace-root --ignore-scripts
COPY web web
RUN npm run build --workspace=web

FROM nginx:1.27-alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
