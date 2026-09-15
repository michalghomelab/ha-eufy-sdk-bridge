# ha-eufy-sdk-bridge: the SDK + the bridge daemon. No go2rtc — this fork serves control only,
# video comes from Frigate, which already pulls the camera's own RTSP.
#
# ── SDK sourcing ────────────────────────────────────────────────────────────────────────────────────
# The SDK (@mega-yfue/eufy-sdk) is a PUBLIC scoped package on npm, so it installs like any dependency —
# `npm install` pulls it (and its runtime deps: mqtt / protobufjs / werift) from the registry, no auth,
# no build context, no sibling checkout. The pinned version lives in package.json; bump it there to move
# the bridge to a newer SDK release. Build with just:
#     docker build -t ha-eufy-sdk-bridge .
FROM node:24-alpine
RUN apk add --no-cache curl
WORKDIR /app

# Install the bridge's deps from npm: the SDK (@mega-yfue/eufy-sdk → pulls mqtt/protobufjs/werift) + ws.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs streams.mjs ./
COPY src ./src
COPY bin ./bin
RUN chmod +x bin/start.sh && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

ENV BRIDGE_APP_DIR=/app BRIDGE_PORT=3000 BRIDGE_HOST=0.0.0.0 \
    EUFY_SESSION=/app/data/.eufy-session.json
RUN mkdir -p /app/data
EXPOSE 3000

CMD [ "eufy-sdk-bridge" ]
