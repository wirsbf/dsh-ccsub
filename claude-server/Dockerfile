# syntax=docker/dockerfile:1
#
# The Claude subscription server.
#
# Node is the base rather than Bun on purpose. The TLS ClientHello this image
# produces was measured against the host's Node and came out identical (same
# JA3, same cipher and extension sets), so running the server in a container
# adds no TLS-fingerprint difference. Bun would produce a *different* Hello —
# closer to the official CLI's BoringSSL shape, but not provably equal to it,
# and its undici layer rewrites response bodies, which breaks byte-exact relay.
#
# Pinned to Node 22 (LTS) with the same major version the server's identity
# block reports, so `x-stainless-runtime-version` stays credible.

FROM node:22-alpine

WORKDIR /app

# Only the runtime dependency; the source is copied explicitly so a stray file
# in the build context cannot land in the image.
#
# `undici` is imported by src/transport.js, so this install must succeed: a
# swallowed failure would still produce an image that builds and then dies at
# startup with ERR_MODULE_NOT_FOUND. Hence no `|| true` here. A lockfile is
# deliberately absent (the package has one runtime dependency), so the version
# is pinned by the range in package.json rather than floating with a stale lock.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && node -e "import('undici').then(()=>process.exit(0),()=>process.exit(1))"

# npm is not needed at runtime and is a large attack surface for a container
# that holds a subscription credential. Remove it only after the install above:
# doing it first would delete the very binary that install step needs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY src ./src

# The grant lives on a volume mounted here. Declaring the directory owned by the
# runtime user means a fresh named volume inherits the right ownership, so the
# server can create the grant file without running as root.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=4710 \
    GRANT_PATH=/data/grant.json

EXPOSE 4710

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.LISTEN_PORT||4710)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
