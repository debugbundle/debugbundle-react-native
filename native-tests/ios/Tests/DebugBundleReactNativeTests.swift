import DebugBundle
import Foundation
import XCTest
@testable import DebugBundleReactNativeBridge

final class DebugBundleReactNativeTests: XCTestCase {
	override func setUp() {
		super.setUp()
		DebugBundle.reset()
	}

	func testInitializeMapsFullConfigurationAndReturnsState() throws {
		let module = DebugBundleReactNative()
		DebugBundle.recorder.lastEventAt = Date(timeIntervalSince1970: 1_234)
		var resolved: [String: Any]?

		module.initialize(
			[
				"sdkVersion": "1.2.7",
				"projectToken": "project-token",
				"enabled": false,
				"environment": "staging",
				"service": "checkout-mobile",
				"endpoint": "https://ingest.example.test",
				"batchSize": 4,
				"flushInterval": 1_250,
				"sampleRate": 0.5,
				"sessionSampleRate": 0.75,
				"requestTimeout": 2_500,
				"releaseChannel": "beta",
				"appVersion": "4.2.0",
				"buildNumber": "42",
				"maxEventsPerSession": 55,
				"maxBreadcrumbs": 12,
				"captureScreens": false,
				"captureActions": true,
				"captureNetwork": false,
				"captureLogs": false,
				"logLevel": "debug",
				"tracePropagationTargets": ["api.example.test"],
				"offlineQueueMaxEvents": 75,
				"offlineQueueMaxBytes": 4_096,
				"offlineQueueTtl": 9_000,
				"maxProbeLabels": 8,
				"maxProbeEntriesPerLabel": 3,
				"probeFlushOnError": false,
				"redactFields": ["password"],
				"headerAllowlist": ["x-request-id"]
			],
			resolver: { resolved = $0 as? [String: Any] },
			rejecter: rejectUnexpectedly
		)

		let config = try XCTUnwrap(DebugBundle.recorder.config)
		XCTAssertEqual(config.sdkVersion, "1.2.7")
		XCTAssertEqual(config.service, "checkout-mobile")
		XCTAssertEqual(config.environment, "staging")
		XCTAssertEqual(config.endpoint.absoluteString, "https://ingest.example.test")
		XCTAssertEqual(config.flushInterval, 1.25)
		XCTAssertEqual(config.requestTimeout, 2.5)
		XCTAssertEqual(config.offlineQueueTtl, 9)
		XCTAssertEqual(config.logLevel, .debug)
		XCTAssertEqual(config.tracePropagationTargets, ["api.example.test"])
		XCTAssertEqual(resolved?["status"] as? String, "initialized")
		XCTAssertEqual(resolved?["lastEventAt"] as? Double, 1_234_000)
		XCTAssertEqual(resolved?["nativeModuleAvailable"] as? Bool, true)
	}

	func testInitializeUsesSafeDefaultsForInvalidOptionalValues() throws {
		let module = DebugBundleReactNative()
		var resolved: [String: Any]?

		module.initialize(
			[
            "endpoint": "http://[",
				"redactFields": 4,
				"headerAllowlist": 4
			],
			resolver: { resolved = $0 as? [String: Any] },
			rejecter: rejectUnexpectedly
		)

		let config = try XCTUnwrap(DebugBundle.recorder.config)
		XCTAssertEqual(config.sdkVersion, "1.2.0")
		XCTAssertEqual(config.service, "react-native-app")
		XCTAssertEqual(config.environment, "production")
		XCTAssertEqual(config.batchSize, 10)
		XCTAssertEqual(config.endpoint, DebugBundleConfig.defaultEndpoint)
		XCTAssertEqual(config.redactFields, DebugBundleConfig.defaultRedactFields)
		XCTAssertEqual(config.headerAllowlist, DebugBundleConfig.defaultHeaderAllowlist)
		XCTAssertTrue(resolved?["lastEventAt"] is NSNull)
	}

	func testCanonicalAndLegacyEventFamiliesDelegateToFoundation() {
		let module = DebugBundleReactNative()
		var canonicalResult: Bool?

		module.enqueueCanonicalEvent(
			[
				"event_type": "frontend_exception",
				NSNull(): "ignored",
				"nullable": NSNull()
			],
			resolver: { canonicalResult = $0 as? Bool },
			rejecter: rejectUnexpectedly
		)
		XCTAssertEqual(canonicalResult, true)
		XCTAssertEqual(DebugBundle.recorder.externalEvents.count, 1)
		XCTAssertNil(DebugBundle.recorder.externalEvents[0]["nullable"]!)

		for eventType in [
			"frontend_exception",
			"frontend_breadcrumb",
			"log_event",
			"request_event",
			"custom_event"
		] {
			module.enqueueEvent(
				[
					"event_type": eventType,
					"correlation": ["trace_id": "trace-rn"],
					"payload": [
						"breadcrumb_type": "screen_transition",
						"message": "checkout failed",
						"level": "error",
						"method": "POST",
						"url": "https://example.test/checkout",
						"route_template": "/checkout",
						"response_status": 503,
						"duration_ms": 12
					]
				],
				resolver: { _ in },
				rejecter: rejectUnexpectedly
			)
		}

		XCTAssertEqual(DebugBundle.recorder.exceptionCount, 1)
		XCTAssertEqual(DebugBundle.recorder.breadcrumbs.first?.0, "screen_transition")
		XCTAssertEqual(DebugBundle.recorder.logs.first?.0, "checkout failed")
		XCTAssertEqual(DebugBundle.recorder.logs.first?.1, .error)
		XCTAssertEqual(DebugBundle.recorder.requests.first?.0.traceId, "trace-rn")
		XCTAssertEqual(DebugBundle.recorder.requests.first?.1.statusCode, 503)
		XCTAssertEqual(DebugBundle.recorder.messages, ["react_native_event:custom_event"])
	}

	func testEveryLogLevelAndLegacyFallbackIsMapped() {
		let module = DebugBundleReactNative()
		let expected: [(String?, DebugBundleLogLevel)] = [
			("debug", .debug),
			("info", .info),
			("error", .error),
			("critical", .critical),
			("unexpected", .warning),
			(nil, .warning)
		]

		for (value, level) in expected {
			var payload: [String: Any] = ["message": "log"]
			if let value {
				payload["level"] = value
			}
			module.enqueueEvent(
				["event_type": "log_event", "payload": payload],
				resolver: { _ in },
				rejecter: rejectUnexpectedly
			)
			XCTAssertEqual(DebugBundle.recorder.logs.last?.1, level)
		}

		module.enqueueEvent(
			["payload": ["message": "fallback"]],
			resolver: { _ in },
			rejecter: rejectUnexpectedly
		)
		XCTAssertEqual(DebugBundle.recorder.messages.last, "react_native_event:unknown")
	}

	func testContextStatusTriggerAndProbeMethodsPreserveValues() {
		let module = DebugBundleReactNative()
		module.initialize(
			[
				"sdkVersion": "1.2.7",
				"service": "checkout-mobile",
				"environment": "test"
			],
			resolver: { _ in },
			rejecter: rejectUnexpectedly
		)
		module.setContext(
			"tenant",
			value: "checkout",
			resolver: { _ in },
			rejecter: rejectUnexpectedly
		)
		module.setContextValue(
			"nullable",
			entry: ["value": NSNull()],
			resolve: { _ in },
			reject: rejectUnexpectedly
		)
		module.activateProbeTriggerToken(
			"trigger",
			resolver: { XCTAssertEqual($0 as? Bool, true) },
			rejecter: rejectUnexpectedly
		)
		XCTAssertTrue(module.isProbeActive("checkout.*"))
		module.captureProbe(
			"checkout.cart",
			data: ["count": 2, "nullable": NSNull()],
			occurredAt: "2026-07-28T12:00:00.000Z",
			resolver: { XCTAssertEqual($0 as? Bool, true) },
			rejecter: rejectUnexpectedly
		)
		module.getStatus(
			resolve: {
				let state = $0 as? [String: Any]
				XCTAssertEqual(state?["status"] as? String, "initialized")
			},
			rejecter: rejectUnexpectedly
		)

		XCTAssertEqual(DebugBundle.recorder.context["tenant"] as? String, "checkout")
		XCTAssertNil(DebugBundle.recorder.context["nullable"]!)
		XCTAssertEqual(DebugBundle.recorder.triggerTokens, ["trigger"])
		XCTAssertEqual(DebugBundle.recorder.externalProbes.first?.0, "1.2.7")
		XCTAssertEqual(DebugBundle.recorder.externalProbes.first?.1, "checkout-mobile")
		XCTAssertEqual(DebugBundle.recorder.externalProbes.first?.2, "test")
		XCTAssertNil(DebugBundle.recorder.externalProbes.first?.4["nullable"]!)
		XCTAssertFalse(DebugBundleReactNative.requiresMainQueueSetup())
	}

	func testFlushResolvesAfterFoundationFlushCompletes() {
		let module = DebugBundleReactNative()
		let expectation = expectation(description: "flush resolved")

		module.flush(
			resolve: { _ in expectation.fulfill() },
			rejecter: rejectUnexpectedly
		)

		wait(for: [expectation], timeout: 2)
		XCTAssertEqual(DebugBundle.recorder.flushCount, 1)
	}

	private func rejectUnexpectedly(_ code: String?, _ message: String?, _ error: Error?) {
		XCTFail("Unexpected native bridge rejection: \(code ?? "") \(message ?? "") \(String(describing: error))")
	}
}
