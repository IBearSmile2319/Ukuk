# syntax=docker/dockerfile:1.7
# Motor Ukuk: compilación multi-etapa, imagen final mínima y sin root.

ARG RUST_VERSION=1.97
ARG DEBIAN_RELEASE=bookworm

FROM rust:${RUST_VERSION}-slim-${DEBIAN_RELEASE} AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p ukuk-engine \
    && install -Dm755 target/release/ukuk-engine /out/ukuk-engine

FROM debian:${DEBIAN_RELEASE}-slim AS runtime
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin ukuk \
    && mkdir -p /data \
    && chown ukuk /data
COPY --from=build /out/ukuk-engine /usr/local/bin/ukuk-engine
ENV UKUK_ENGINE_ADDR=0.0.0.0:8090 \
    UKUK_DATA_DIR=/data \
    RUST_LOG=info
USER ukuk
VOLUME ["/data"]
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/ukuk-engine"]
