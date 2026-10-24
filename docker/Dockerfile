# salad-whisper — local whisper.cpp STT server for the Pi voice extension
# Build:  docker build -t salad-whisper .pi/extensions/salad-voice/docker
# Run:    docker run --rm -p 8081:8081 salad-whisper
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends       build-essential cmake git ca-certificates curl     && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp     && cd whisper.cpp     && cmake -B build -DGGML_CUDA=OFF     && cmake --build build --config Release -j"$(nproc)"

# Model: base.en (~142 MB, English). For better accuracy use small.en
# (~244 MB) — swap the URL below.
RUN mkdir -p /models     && curl -sL --max-time 600 -o /models/ggml-base.en.bin        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

EXPOSE 8081
ENTRYPOINT ["/opt/whisper.cpp/build/bin/whisper-server"]
CMD ["--model", "/models/ggml-base.en.bin", "--host", "0.0.0.0", "--port", "8081"]
