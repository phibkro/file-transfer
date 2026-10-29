# The self-hosted platform as one container: plain workerd running the room Worker and the assets Worker
# (workerd.capnp). Build from the repository root:
#
#   docker build -f platforms/self-hosted/Dockerfile -t file-transfer .
#   docker run -p 8080:8080 -v file-transfer-storage:/srv/storage file-transfer
#
# Multi-architecture (linux/amd64 and linux/arm64) without emulation: the JavaScript builds once on the build
# machine's architecture, the workerd binary for the target architecture comes from npm, and the final stage runs no
# commands, so `docker buildx build --platform linux/amd64,linux/arm64` needs no QEMU.
#
# Settings are environment variables (see workerd.capnp and the site's "Run your own" page). Put a TLS-terminating
# proxy in front, and set CLIENT_ADDRESS_HEADER to the header it writes the client address into.

FROM --platform=$BUILDPLATFORM oven/bun:1.4 AS build
ARG TARGETARCH
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile
RUN cd platforms/self-hosted && bun run build
# The workerd binary for the target architecture, at the version the build installed (npm names amd64 "64").
RUN version="$(bun -e 'console.log(require("/source/platforms/self-hosted/node_modules/workerd/package.json").version)')" \
  && arch="$([ "$TARGETARCH" = "amd64" ] && echo 64 || echo "$TARGETARCH")" \
  && bun -e "const response = await fetch(process.argv[1]); if (!response.ok) throw new Error(String(response.status)); await Bun.write('/tmp/workerd.tgz', response)" \
    "https://registry.npmjs.org/@cloudflare/workerd-linux-${arch}/-/workerd-linux-${arch}-${version}.tgz" \
  && mkdir -p /tmp/workerd /out/storage \
  && tar -xzf /tmp/workerd.tgz -C /tmp/workerd \
  && cp /tmp/workerd/package/bin/workerd /out/workerd \
  && cp -r platforms/self-hosted/workerd.capnp platforms/self-hosted/dist platforms/self-hosted/public /out/

# Distroless: glibc and the system CA certificates workerd loads at start-up, and nothing else (no shell).
FROM gcr.io/distroless/base-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/phibkro/file-transfer"
LABEL org.opencontainers.image.description="End-to-end encrypted file transfer: the self-hosted server node (workerd)"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build --chmod=755 /out/workerd /usr/local/bin/workerd
COPY --from=build /out/workerd.capnp /srv/workerd.capnp
COPY --from=build /out/dist /srv/dist
COPY --from=build /out/public /srv/public
# Owned by the unprivileged user the server runs as, 10001 as in earlier images, so existing storage volumes stay
# writable; a numeric user needs no entry in /etc/passwd.
COPY --from=build --chown=10001:10001 /out/storage /srv/storage
WORKDIR /srv
USER 10001:10001
EXPOSE 8080
VOLUME /srv/storage
ENTRYPOINT ["workerd", "serve", "/srv/workerd.capnp"]
