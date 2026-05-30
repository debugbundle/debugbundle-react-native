SHELL := /bin/bash

ANDROID_SDK_ROOT ?= $(CURDIR)/../debugbundle-android/.android-sdk
ANDROID_HOME ?= $(ANDROID_SDK_ROOT)
ANDROID_USER_HOME ?= $(CURDIR)/../debugbundle-android/.android-home
GRADLE_USER_HOME ?= $(CURDIR)/.gradle-cache
GRADLEW ?= $(CURDIR)/../debugbundle-android/gradlew
GRADLE_RUNNER ?= docker
GRADLE_IMAGE ?= gradle:9.4.1-jdk21
DOCKER_PLATFORM ?= linux/amd64
DOCKER_WORKDIR := /workspace
DOCKER_ANDROID_SDK_ROOT := /android-sdk
DOCKER_ANDROID_USER_HOME := /android-home
DOCKER_RUN = docker run --rm -t --platform "$(DOCKER_PLATFORM)" \
	-v "$(CURDIR):$(DOCKER_WORKDIR)" \
	-v "$(ANDROID_SDK_ROOT):$(DOCKER_ANDROID_SDK_ROOT)" \
	-v "$(ANDROID_USER_HOME):$(DOCKER_ANDROID_USER_HOME)" \
	-v "$(GRADLE_USER_HOME):/home/gradle/.gradle" \
	-w "$(DOCKER_WORKDIR)" \
	-e ANDROID_SDK_ROOT="$(DOCKER_ANDROID_SDK_ROOT)" \
	-e ANDROID_HOME="$(DOCKER_ANDROID_SDK_ROOT)" \
	-e ANDROID_USER_HOME="$(DOCKER_ANDROID_USER_HOME)" \
	$(GRADLE_IMAGE)

ifeq ($(GRADLE_RUNNER),wrapper)
ANDROID_COMPILE_CMD = ANDROID_SDK_ROOT="$(ANDROID_SDK_ROOT)" ANDROID_HOME="$(ANDROID_HOME)" ANDROID_USER_HOME="$(ANDROID_USER_HOME)" GRADLE_USER_HOME="$(GRADLE_USER_HOME)" "$(GRADLEW)" --no-daemon --console=plain -Dorg.gradle.vfs.watch=false
else
ANDROID_COMPILE_CMD = $(DOCKER_RUN) gradle --no-daemon --console=plain -Dorg.gradle.vfs.watch=false
endif

.PHONY: build typecheck test pack smoke android-compile rn-smoke-ios rn-smoke-android rn-smoke verify clean

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

pack:
	npm run build
	npm pack --dry-run

smoke:
	node scripts/smoke-packed.mjs

android-compile:
	$(ANDROID_COMPILE_CMD) :debugbundle-react-native:compileDebugJavaWithJavac

rn-smoke-ios:
	node scripts/smoke-react-native-app.mjs --ios

rn-smoke-android:
	node scripts/smoke-react-native-app.mjs --android

rn-smoke:
	node scripts/smoke-react-native-app.mjs

verify: typecheck test smoke android-compile

clean:
	rm -rf dist .smoke .gradle-cache-rn-smoke *.tgz
