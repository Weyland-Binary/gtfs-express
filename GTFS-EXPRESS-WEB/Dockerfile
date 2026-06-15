# Stage 1: build the React app (Vite)
FROM node:24-alpine AS builder
WORKDIR /app

# Work around corporate SSL-intercepting proxies during the build
RUN npm config set strict-ssl false

COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# API base URL baked into the bundle at build time
ARG VITE_API_BASE_URL=/api/gtfs
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# Stage 2: serve the static bundle with Nginx
FROM nginx:alpine
ARG APK_INSECURE=false
RUN if [ "$APK_INSECURE" = "true" ]; then \
      sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories; \
    fi \
 && apk add --no-cache wget
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/nginx-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
