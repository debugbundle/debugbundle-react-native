import Foundation
import React
import DebugBundle

@objc(DebugBundleReactNative)
final class DebugBundleReactNative: NSObject {
	private var currentSDKVersion = "1.2.0"
	private var currentService = "react-native-app"
	private var currentEnvironment = "production"

	@objc(initialize:resolve:reject:)
	func initialize(
		_ config: NSDictionary,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		currentSDKVersion = config["sdkVersion"] as? String ?? "1.2.0"
		currentService = config["service"] as? String ?? "react-native-app"
		currentEnvironment = config["environment"] as? String ?? "production"
		let sdkConfig = DebugBundleConfig(
			projectToken: config["projectToken"] as? String ?? "",
			enabled: config["enabled"] as? Bool ?? true,
			environment: currentEnvironment,
			service: currentService,
			endpoint: URL(string: config["endpoint"] as? String ?? DebugBundleConfig.defaultEndpoint.absoluteString) ?? DebugBundleConfig.defaultEndpoint,
			batchSize: integer(config["batchSize"], fallback: 10),
			flushInterval: milliseconds(config["flushInterval"], fallback: 3_000),
			sampleRate: number(config["sampleRate"], fallback: 1),
			sessionSampleRate: number(config["sessionSampleRate"], fallback: 1),
			requestTimeout: milliseconds(config["requestTimeout"], fallback: 5_000),
			releaseChannel: config["releaseChannel"] as? String ?? "production",
			appVersion: config["appVersion"] as? String,
			buildNumber: config["buildNumber"] as? String,
			maxEventsPerSession: integer(config["maxEventsPerSession"], fallback: 100),
			maxBreadcrumbs: integer(config["maxBreadcrumbs"], fallback: 20),
			captureScreens: config["captureScreens"] as? Bool ?? true,
			captureActions: config["captureActions"] as? Bool ?? false,
			captureNetwork: config["captureNetwork"] as? Bool ?? true,
			captureLogs: config["captureLogs"] as? Bool ?? true,
			logLevel: logLevel(config["logLevel"] as? String),
			tracePropagationTargets: config["tracePropagationTargets"] as? [String] ?? [],
			offlineQueueMaxEvents: integer(config["offlineQueueMaxEvents"], fallback: 500),
			offlineQueueMaxBytes: integer(config["offlineQueueMaxBytes"], fallback: 5 * 1024 * 1024),
			offlineQueueTtl: milliseconds(config["offlineQueueTtl"], fallback: 72 * 60 * 60 * 1_000),
			maxProbeLabels: integer(config["maxProbeLabels"], fallback: 50),
			maxProbeEntriesPerLabel: integer(config["maxProbeEntriesPerLabel"], fallback: 10),
			probeFlushOnError: config["probeFlushOnError"] as? Bool ?? true,
			redactFields: stringSet(config["redactFields"], fallback: DebugBundleConfig.defaultRedactFields),
			headerAllowlist: stringSet(config["headerAllowlist"], fallback: DebugBundleConfig.defaultHeaderAllowlist),
			sdkVersion: currentSDKVersion
		)
		DebugBundle.initialize(sdkConfig, transport: DebugBundleHTTPTransport())
		resolve(state())
	}

	@objc(enqueueCanonicalEvent:resolve:reject:)
	func enqueueCanonicalEvent(
		_ event: NSDictionary,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		resolve(DebugBundle.captureExternalEvent(dictionary(event)))
	}

	@objc(enqueueEvent:resolve:reject:)
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

	@objc(flush:reject:)
	func flush(resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
		Task {
			await DebugBundle.flush()
			resolve(nil)
		}
	}

	@objc(getStatus:reject:)
	func getStatus(resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
		resolve(state())
	}

	@objc(setContext:value:resolve:reject:)
	func setContext(
		_ key: String,
		value: Any?,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		DebugBundle.setContext(key, value: value)
		resolve(nil)
	}

	@objc(setContextValue:entry:resolve:reject:)
	func setContextValue(
		_ key: String,
		entry: NSDictionary,
		resolve: @escaping RCTPromiseResolveBlock,
		reject: @escaping RCTPromiseRejectBlock
	) {
		let value = entry["value"]
		DebugBundle.setContext(key, value: value is NSNull ? nil : value)
		resolve(nil)
	}

	@objc(activateProbeTriggerToken:resolve:reject:)
	func activateProbeTriggerToken(
		_ token: String,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		resolve(DebugBundle.activateProbeTriggerToken(token))
	}

	@objc(isProbeActive:)
	func isProbeActive(_ label: String) -> Bool {
		DebugBundle.isExternalProbeActive(label)
	}

	@objc(captureProbe:data:occurredAt:resolve:reject:)
	func captureProbe(
		_ label: String,
		data: NSDictionary,
		occurredAt: String,
		resolver resolve: @escaping RCTPromiseResolveBlock,
		rejecter reject: @escaping RCTPromiseRejectBlock
	) {
		resolve(
			DebugBundle.captureExternalProbe(
				sdkVersion: currentSDKVersion,
				service: currentService,
				environment: currentEnvironment,
				label: label,
				data: dictionary(data),
				occurredAt: occurredAt
			)
		)
	}

	@objc
	static func requiresMainQueueSetup() -> Bool {
		false
	}

	private func state() -> [String: Any] {
		[
			"status": DebugBundle.status.rawValue,
			"lastEventAt": DebugBundle.lastEventAt.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull(),
			"nativeModuleAvailable": true
		]
	}
}

private func dictionary(_ value: NSDictionary) -> [String: Any?] {
	var result: [String: Any?] = [:]
	for (rawKey, rawValue) in value {
		guard let key = rawKey as? String else {
			continue
		}
		if rawValue is NSNull {
			result.updateValue(nil, forKey: key)
		} else {
			result[key] = rawValue
		}
	}
	return result
}

private func integer(_ value: Any?, fallback: Int) -> Int {
	(value as? NSNumber)?.intValue ?? fallback
}

private func number(_ value: Any?, fallback: Double) -> Double {
	(value as? NSNumber)?.doubleValue ?? fallback
}

private func milliseconds(_ value: Any?, fallback: Double) -> TimeInterval {
	number(value, fallback: fallback) / 1_000
}

private func stringSet(_ value: Any?, fallback: Set<String>) -> Set<String> {
	guard let values = value as? [String] else {
		return fallback
	}
	return Set(values)
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
