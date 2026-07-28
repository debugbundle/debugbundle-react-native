#!/bin/sh
set -eu

if [ -d /smoke-source ]; then
  mkdir -p /workspace
  cp -a /smoke-source/. /workspace/
fi

cd /workspace/android
./gradlew "$@"

if [ -n "${RN_SMOKE_APK_OUTPUT:-}" ]; then
  cp "/workspace/android/app/build/outputs/apk/${RN_SMOKE_APK_OUTPUT}" /smoke-output/
fi
