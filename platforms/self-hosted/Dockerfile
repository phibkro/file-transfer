# The self-hosted platform as one container: plain workerd running the room Worker and the assets Worker
# (workerd.capnp). Build from the repository root:
#
#   docker build -f platforms/self-hosted/Dockerfile -t file-transfer .
#   docker run -p 8080:8080 -v file-transfer-storage:/srv/storage file-transfer
#
# Settings are environment variables (see workerd.capnp and the site's "Run your own" page). Put a TLS-terminating
# proxy in front, and set CLIENT_ADDRESS_HEADER to the header it writes the client address into.

FROM oven/bun:1.4 AS build
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile
RUN cd platforms/self-hosted && bun run build
# The workerd binary for this platform, from the npm package the build installed.
RUN mkdir -p /out \
  && cp "$(find /source/node_modules/.bun -path '*/@cloudflare/workerd-linux-*/bin/workerd' -type f | head -n 1)" /out/workerd \
  && cp -r platforms/self-hosted/workerd.capnp platforms/self-hosted/dist platforms/self-hosted/public /out/

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/phibkro/file-transfer"
LABEL org.opencontainers.image.description="End-to-end encrypted file transfer: the self-hosted server (workerd)"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
RUN useradd --system --uid 10001 --home-dir /srv transfer \
  && mkdir -p /srv/storage \
  && chown transfer /srv/storage
COPY --from=build /out/workerd /usr/local/bin/workerd
COPY --from=build /out/workerd.capnp /srv/workerd.capnp
COPY --from=build /out/dist /srv/dist
COPY --from=build /out/public /srv/public
WORKDIR /srv
USER transfer
EXPOSE 8080
VOLUME /srv/storage
ENTRYPOINT ["workerd", "serve", "/srv/workerd.capnp"]
