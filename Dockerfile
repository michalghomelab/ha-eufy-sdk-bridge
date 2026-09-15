# ha-eufy-sdk-bridge: the SDK + the bridge daemon. No go2rtc — this fork serves control only,
# video comes from Frigate, which already pulls the camera's own RTSP.
#
# ── SDK sourcing ────────────────────────────────────────────────────────────────────────────────────
# The forked SDK is pinned to an immutable git commit in package.json/package-lock.json. Its `prepare`
# script builds dist during `npm ci`, so an image can never silently reuse a stale checked-in bundle.
# Bump both files deliberately when moving the bridge to a verified SDK commit. Build with just:
#     docker build -t ha-eufy-sdk-bridge .
FROM node:24.21.0-alpine@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2 AS dependencies
RUN apk add --no-cache git
WORKDIR /app

# Build/install production dependencies. Git is needed only here to fetch the immutable SDK revision;
# it is deliberately absent from the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.21.0-alpine@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2 AS runtime
RUN apk add --no-cache curl
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.mjs streams.mjs ./
COPY src ./src
COPY bin ./bin
RUN chmod +x bin/start.sh && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

# Only what differs from the code's own defaults: the app lives at /app and the session belongs on the
# volume. Host and port are 0.0.0.0:3000 in config.mjs already — repeating them here reads as though a
# deployment has to set them, and compose maps the port anyway.
ENV BRIDGE_APP_DIR=/app EUFY_SESSION=/app/data/.eufy-session.json
RUN mkdir -p /app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${BRIDGE_PORT:-3000}/healthz" >/dev/null || exit 1

CMD [ "eufy-sdk-bridge" ]
