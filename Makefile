SHELL := /bin/bash

ANDROID_SDK_ROOT ?= $(CURDIR)/../debugbundle-android/.android-sdk
ANDROID_HOME ?= $(ANDROID_SDK_ROOT)
ANDROID_USER_HOME ?= $(CURDIR)/../debugbundle-android/.android-home
ANDROID_SDK_SOURCE ?= $(CURDIR)/../debugbundle-android
ANDROID_COORDINATED_VERSION ?= $(shell sed -n 's/^VERSION_NAME=//p' "$(ANDROID_SDK_SOURCE)/gradle.properties")
ANDROID_NATIVE_RELEASE_VERSION ?= 1.2.0
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
ANDROID_STAGE_ENV =
ANDROID_STAGED_REPOSITORY = $(CURDIR)/.smoke/android-maven
else
ANDROID_COMPILE_CMD = $(DOCKER_RUN) gradle --no-daemon --console=plain -Dorg.gradle.vfs.watch=false
ANDROID_STAGE_ENV = RN_SMOKE_ANDROID_STAGE_RUNNER=docker
ANDROID_STAGED_REPOSITORY = $(DOCKER_WORKDIR)/.smoke/android-maven
endif

NATIVE_PLATFORM_TARGETS := android-test
ifeq ($(shell uname -s),Darwin)
NATIVE_PLATFORM_TARGETS += ios-test
endif

.PHONY: build typecheck test pack smoke smoke-package-manager smoke-registry android-compile android-test android-compile-published ios-test rn-smoke-ios rn-smoke-android rn-smoke-expo-android rn-smoke-expo-ios rn-smoke-ios-published rn-smoke-android-published rn-runtime-ios rn-runtime-android rn-smoke verify verify-native clean

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

smoke-package-manager:
	node scripts/smoke-package-manager.mjs "$(PM)"

smoke-registry:
	npm run smoke:registry

android-compile:
	$(ANDROID_STAGE_ENV) DEBUGBUNDLE_ANDROID_SDK_SOURCE="$(ANDROID_SDK_SOURCE)" ANDROID_SDK_ROOT="$(ANDROID_SDK_ROOT)" ANDROID_USER_HOME="$(ANDROID_USER_HOME)" node scripts/smoke-react-native-app.mjs --stage-android-sdk-only
	$(ANDROID_COMPILE_CMD) -PdebugBundleAndroidVersion="$(ANDROID_COORDINATED_VERSION)" -PdebugBundleAndroidRepository="$(ANDROID_STAGED_REPOSITORY)" :debugbundle-react-native:compileDebugJavaWithJavac

android-test:
	$(ANDROID_STAGE_ENV) DEBUGBUNDLE_ANDROID_SDK_SOURCE="$(ANDROID_SDK_SOURCE)" ANDROID_SDK_ROOT="$(ANDROID_SDK_ROOT)" ANDROID_USER_HOME="$(ANDROID_USER_HOME)" node scripts/smoke-react-native-app.mjs --stage-android-sdk-only
	$(ANDROID_COMPILE_CMD) -PdebugBundleAndroidVersion="$(ANDROID_COORDINATED_VERSION)" -PdebugBundleAndroidRepository="$(ANDROID_STAGED_REPOSITORY)" :debugbundle-react-native:verifyAndroidWrapperCoverage

android-compile-published:
	$(ANDROID_COMPILE_CMD) -PdebugBundleAndroidVersion="$(ANDROID_NATIVE_RELEASE_VERSION)" :debugbundle-react-native:compileDebugJavaWithJavac

ios-test:
	scripts/verify-ios-wrapper-coverage.sh

rn-smoke-ios:
	node scripts/smoke-react-native-app.mjs --ios

rn-runtime-ios:
	node scripts/smoke-react-native-app.mjs --ios --runtime

rn-smoke-android:
	node scripts/smoke-react-native-app.mjs --android

rn-smoke-expo-android:
	node scripts/smoke-react-native-app.mjs --android --expo

rn-smoke-expo-ios:
	node scripts/smoke-react-native-app.mjs --ios --expo

rn-smoke-ios-published:
	RN_SMOKE_NATIVE_SOURCE=published node scripts/smoke-react-native-app.mjs --ios

rn-smoke-android-published:
	RN_SMOKE_NATIVE_SOURCE=published DEBUGBUNDLE_ANDROID_VERSION="$(ANDROID_NATIVE_RELEASE_VERSION)" node scripts/smoke-react-native-app.mjs --android

rn-runtime-android:
	node scripts/smoke-react-native-app.mjs --android --runtime

rn-smoke:
	node scripts/smoke-react-native-app.mjs

verify: typecheck test smoke

verify-native: verify $(NATIVE_PLATFORM_TARGETS)

clean:
	rm -rf dist .smoke .gradle-cache-rn-smoke .native-coverage .build *.tgz
