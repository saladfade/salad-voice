# salad-voice — audio.cpp CPU-only STT/TTS server (Parakeet STT, Kokoro + Qwen3 TTS)
# Build:  docker build -t salad-audiocpp .pi/extensions/salad-voice/docker
# Run:    docker run -d --name salad-audiocpp --cpus 4 --memory 6g \
#           -p 127.0.0.1:8082:8082 -v salad-audiocpp-models:/models salad-audiocpp
# Models are NOT baked in: entrypoint.sh downloads them into the /models volume on first start.

ARG UBUNTU_VERSION=24.04
ARG AUDIOCPP_REF=dd92e32b6e268178ff43f4fa3ca36f0b380491e0

FROM docker.io/ubuntu:${UBUNTU_VERSION} AS build
ARG AUDIOCPP_REF
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc-14 g++-14 make cmake libgomp1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ENV CC=gcc-14 CXX=g++-14
WORKDIR /src
RUN curl -fsSL "https://github.com/0xShug0/audio.cpp/archive/${AUDIOCPP_REF}.tar.gz" | tar -xz --strip-components=1
RUN cmake -S . -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DAUDIOCPP_MODEL_SET=custom \
        -DAUDIOCPP_MODELS=parakeet_tdt,kokoro_tts,qwen3_tts \
        -DENGINE_ENABLE_CUDA=OFF -DENGINE_ENABLE_HIP=OFF -DENGINE_ENABLE_VULKAN=OFF -DENGINE_ENABLE_METAL=OFF \
        -DENGINE_ENABLE_CPU_ALL_VARIANTS=ON \
        -DENGINE_ENABLE_OPENMP=ON \
        -DAUDIOCPP_BUILD_NATIVE_MODEL_MANAGER=OFF \
        -DENGINE_BUILD_EXAMPLES=OFF -DENGINE_BUILD_TESTS=OFF -DENGINE_BUILD_WARMBENCH=OFF \
    && cmake --build build --parallel "$(nproc)" --target audiocpp_server \
    && mkdir -p /out && cp build/bin/audiocpp_server /out/ \
    && find build -name '*.so*' -exec cp -P {} /out/ \;

FROM docker.io/ubuntu:${UBUNTU_VERSION} AS final
ARG AUDIOCPP_REF
LABEL org.opencontainers.image.source="https://github.com/saladfade/salad-voice" \
      org.opencontainers.image.revision="${AUDIOCPP_REF}"
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 libespeak-ng1 espeak-ng-data curl ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
WORKDIR /app
COPY --from=build /out/ /app/
COPY server.json entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh && mkdir -p /models && chown ubuntu:ubuntu /models
USER ubuntu
EXPOSE 8082
ENTRYPOINT ["/app/entrypoint.sh"]
