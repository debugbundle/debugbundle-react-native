FROM node:26-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    make \
    g++ \
    openjdk-17-jdk \
    python3 \
    unzip \
  && rm -rf /var/lib/apt/lists/*
