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

# Basemap provider and key baked into the bundle (see
# src/components/map/basemapConfig.js). Empty: OpenFreeMap, no key.
ARG VITE_BASEMAP_PROVIDER=
ARG VITE_CARTO_API_KEY=
ARG VITE_MAPTILER_KEY=
ENV VITE_BASEMAP_PROVIDER=$VITE_BASEMAP_PROVIDER \
    VITE_CARTO_API_KEY=$VITE_CARTO_API_KEY \
    VITE_MAPTILER_KEY=$VITE_MAPTILER_KEY
# Say what the bundle will use, so a build that missed its key (compose run
# without --env-file) is visible in the log rather than silently keyless.
RUN echo "basemap: provider=${VITE_BASEMAP_PROVIDER:-inferred} carto_key=$([ -n "$VITE_CARTO_API_KEY" ] && echo set || echo none) maptiler_key=$([ -n "$VITE_MAPTILER_KEY" ] && echo set || echo none)"

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
