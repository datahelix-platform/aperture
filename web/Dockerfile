# Aperture SPA — static build served by nginx (DataHelix 1.0 epic P1.4,
# issue #22). The image is deployment-agnostic: VITE_* endpoint config is NOT
# baked at build; the entrypoint script injects it into config.js from
# container env at start (docker/40-aperture-config.sh).

FROM node:26-alpine AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="aperture" \
      org.opencontainers.image.description="Aperture — interface layer for the DataHelix platform" \
      org.opencontainers.image.source="https://github.com/datahelix-platform/aperture" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

COPY --from=builder /build/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# The nginx image runs /docker-entrypoint.d/*.sh before serving.
COPY docker/40-aperture-config.sh /docker-entrypoint.d/40-aperture-config.sh

EXPOSE 80
