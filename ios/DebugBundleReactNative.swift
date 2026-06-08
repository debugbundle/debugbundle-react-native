import Foundation
import React
import DebugBundle

@objc(DebugBundleReactNative)
final class DebugBundleReactNative: NSObject {
	@objc(initialize:resolver:rejecter:)
	func initialize(
		_ config: NSDictionary,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		let sdkConfig = DebugBundleConfig(
			projectToken: config["projectToken"] as? String ?? "",
			enabled: config["enabled"] as? Bool ?? true,
			environment: config["environment"] as? String ?? "production",
			service: config["service"] as? String ?? "react-native-app",
			endpoint: URL(string: config["endpoint"] as? String ?? DebugBundleConfig.defaultEndpoint.absoluteString) ?? DebugBundleConfig.defaultEndpoint,
			releaseChannel: config["releaseChannel"] as? String ?? "production",
			appVersion: config["appVersion"] as? String,
			buildNumber: config["buildNumber"] as? String,
			sdkVersion: config["sdkVersion"] as? String ?? "1.1.0"
		)
		DebugBundle.initialize(sdkConfig, transport: DebugBundleHTTPTransport())
		resolve(state())
	}

	@objc(enqueueEvent:resolver:rejecter:)
	func enqueueEvent(
		_ event: NSDictionary,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		let eventType = event["event_type"] as? String ?? "unknown"
		let payload = event["payload"] as? [String: Any?] ?? [:]
		switch eventType {
		case "frontend_exception":
			DebugBundle.captureException(NSError(domain: "DebugBundleReactNative", code: 1, userInfo: payload.compactMapValues { $0 }))
		case "frontend_breadcrumb":
			DebugBundle.recordBreadcrumb(payload["breadcrumb_type"] as? String ?? "react_native", data: payload)
		case "log_event":
			DebugBundle.captureLog(payload["message"] as? String ?? "", level: logLevel(payload["level"] as? String), context: payload)
		case "request_event":
			let correlation = event["correlation"] as? [String: Any?]
			DebugBundle.captureRequest(
				DebugBundleRequestInfo(
					method: payload["method"] as? String ?? "GET",
					url: payload["url"] as? String ?? "",
					routeTemplate: payload["route_template"] as? String,
					traceId: correlation?["trace_id"] as? String
				),
				response: DebugBundleResponseInfo(
					statusCode: payload["response_status"] as? Int ?? 0,
					durationMillis: payload["duration_ms"] as? Int
				),
				context: payload
			)
		default:
			DebugBundle.captureMessage("react_native_event:\(eventType)", context: payload)
		}
		resolve(nil)
	}

	@objc(flush:rejecter:)
	func flush(resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
		Task {
			await DebugBundle.flush()
			resolve(nil)
		}
	}

	@objc(getStatus:rejecter:)
	func getStatus(resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
		resolve(state())
	}

	@objc(setContext:value:resolver:rejecter:)
	func setContext(
		_ key: String,
		value: Any?,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		DebugBundle.setContext(key, value: value)
		resolve(nil)
	}

	@objc(activateProbeTriggerToken:resolver:rejecter:)
	func activateProbeTriggerToken(
		_ token: String,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		resolve(DebugBundle.activateProbeTriggerToken(token))
	}

	@objc
	static func requiresMainQueueSetup() -> Bool {
		false
	}

	private func state() -> [String: Any?] {
		[
			"status": DebugBundle.status.rawValue,
			"lastEventAt": DebugBundle.lastEventAt.map { $0.timeIntervalSince1970 * 1000 },
			"nativeModuleAvailable": true,
			"degradedReason": nil
		]
	}
}

private func logLevel(_ value: String?) -> DebugBundleLogLevel {
	switch value?.lowercased() {
	case "debug":
		return .debug
	case "info":
		return .info
	case "error":
		return .error
	case "critical":
		return .critical
	default:
		return .warning
	}
}
