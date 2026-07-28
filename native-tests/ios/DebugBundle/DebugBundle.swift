import Foundation

public enum DebugBundleLogLevel: String {
	case debug
	case info
	case warning
	case error
	case critical
}

public enum DebugBundleStatus: String {
	case initialized
	case degraded
}

public struct DebugBundleConfig {
	public static let defaultEndpoint = URL(string: "https://api.debugbundle.com/v1/events")!
	public static let defaultRedactFields: Set<String> = ["password", "token"]
	public static let defaultHeaderAllowlist: Set<String> = ["content-type", "user-agent"]

	public let projectToken: String
	public let enabled: Bool
	public let environment: String
	public let service: String
	public let endpoint: URL
	public let batchSize: Int
	public let flushInterval: TimeInterval
	public let sampleRate: Double
	public let sessionSampleRate: Double
	public let requestTimeout: TimeInterval
	public let releaseChannel: String
	public let appVersion: String?
	public let buildNumber: String?
	public let maxEventsPerSession: Int
	public let maxBreadcrumbs: Int
	public let captureScreens: Bool
	public let captureActions: Bool
	public let captureNetwork: Bool
	public let captureLogs: Bool
	public let logLevel: DebugBundleLogLevel
	public let tracePropagationTargets: [String]
	public let offlineQueueMaxEvents: Int
	public let offlineQueueMaxBytes: Int
	public let offlineQueueTtl: TimeInterval
	public let maxProbeLabels: Int
	public let maxProbeEntriesPerLabel: Int
	public let probeFlushOnError: Bool
	public let redactFields: Set<String>
	public let headerAllowlist: Set<String>
	public let sdkVersion: String

	public init(
		projectToken: String,
		enabled: Bool,
		environment: String,
		service: String,
		endpoint: URL,
		batchSize: Int,
		flushInterval: TimeInterval,
		sampleRate: Double,
		sessionSampleRate: Double,
		requestTimeout: TimeInterval,
		releaseChannel: String,
		appVersion: String?,
		buildNumber: String?,
		maxEventsPerSession: Int,
		maxBreadcrumbs: Int,
		captureScreens: Bool,
		captureActions: Bool,
		captureNetwork: Bool,
		captureLogs: Bool,
		logLevel: DebugBundleLogLevel,
		tracePropagationTargets: [String],
		offlineQueueMaxEvents: Int,
		offlineQueueMaxBytes: Int,
		offlineQueueTtl: TimeInterval,
		maxProbeLabels: Int,
		maxProbeEntriesPerLabel: Int,
		probeFlushOnError: Bool,
		redactFields: Set<String>,
		headerAllowlist: Set<String>,
		sdkVersion: String
	) {
		self.projectToken = projectToken
		self.enabled = enabled
		self.environment = environment
		self.service = service
		self.endpoint = endpoint
		self.batchSize = batchSize
		self.flushInterval = flushInterval
		self.sampleRate = sampleRate
		self.sessionSampleRate = sessionSampleRate
		self.requestTimeout = requestTimeout
		self.releaseChannel = releaseChannel
		self.appVersion = appVersion
		self.buildNumber = buildNumber
		self.maxEventsPerSession = maxEventsPerSession
		self.maxBreadcrumbs = maxBreadcrumbs
		self.captureScreens = captureScreens
		self.captureActions = captureActions
		self.captureNetwork = captureNetwork
		self.captureLogs = captureLogs
		self.logLevel = logLevel
		self.tracePropagationTargets = tracePropagationTargets
		self.offlineQueueMaxEvents = offlineQueueMaxEvents
		self.offlineQueueMaxBytes = offlineQueueMaxBytes
		self.offlineQueueTtl = offlineQueueTtl
		self.maxProbeLabels = maxProbeLabels
		self.maxProbeEntriesPerLabel = maxProbeEntriesPerLabel
		self.probeFlushOnError = probeFlushOnError
		self.redactFields = redactFields
		self.headerAllowlist = headerAllowlist
		self.sdkVersion = sdkVersion
	}
}

public struct DebugBundleHTTPTransport {
	public init() {}
}

public struct DebugBundleRequestInfo {
	public let method: String
	public let url: String
	public let routeTemplate: String?
	public let traceId: String?

	public init(method: String, url: String, routeTemplate: String?, traceId: String?) {
		self.method = method
		self.url = url
		self.routeTemplate = routeTemplate
		self.traceId = traceId
	}
}

public struct DebugBundleResponseInfo {
	public let statusCode: Int
	public let durationMillis: Int?

	public init(statusCode: Int, durationMillis: Int?) {
		self.statusCode = statusCode
		self.durationMillis = durationMillis
	}
}

public final class DebugBundleRecorder: @unchecked Sendable {
	public var config: DebugBundleConfig?
	public var exceptionCount = 0
	public var breadcrumbs: [(String, [String: Any?])] = []
	public var logs: [(String, DebugBundleLogLevel)] = []
	public var requests: [(DebugBundleRequestInfo, DebugBundleResponseInfo)] = []
	public var messages: [String] = []
	public var externalEvents: [[String: Any?]] = []
	public var context: [String: Any?] = [:]
	public var triggerTokens: [String] = []
	public var externalProbes: [(String, String, String, String, [String: Any?], String)] = []
	public var status: DebugBundleStatus = .initialized
	public var lastEventAt: Date?
	public var externalEventResult = true
	public var externalProbeResult = true
	public var probeActive = true
	public var triggerResult = true
	public var flushCount = 0

	public init() {}
}

public enum DebugBundle {
	nonisolated(unsafe) public static var recorder = DebugBundleRecorder()

	public static var status: DebugBundleStatus {
		recorder.status
	}

	public static var lastEventAt: Date? {
		recorder.lastEventAt
	}

	public static func reset() {
		recorder = DebugBundleRecorder()
	}

	public static func initialize(_ config: DebugBundleConfig, transport: DebugBundleHTTPTransport) {
		recorder.config = config
	}

	public static func captureExternalEvent(_ event: [String: Any?]) -> Bool {
		recorder.externalEvents.append(event)
		return recorder.externalEventResult
	}

	public static func captureException(_ error: Error) {
		recorder.exceptionCount += 1
	}

	public static func recordBreadcrumb(_ type: String, data: [String: Any?]) {
		recorder.breadcrumbs.append((type, data))
	}

	public static func captureLog(
		_ message: String,
		level: DebugBundleLogLevel,
		context: [String: Any?]
	) {
		recorder.logs.append((message, level))
	}

	public static func captureRequest(
		_ request: DebugBundleRequestInfo,
		response: DebugBundleResponseInfo,
		context: [String: Any?]
	) {
		recorder.requests.append((request, response))
	}

	public static func captureMessage(_ message: String, context: [String: Any?]) {
		recorder.messages.append(message)
	}

	public static func flush() async {
		recorder.flushCount += 1
	}

	public static func setContext(_ key: String, value: Any?) {
		recorder.context.updateValue(value, forKey: key)
	}

	public static func activateProbeTriggerToken(_ token: String) -> Bool {
		recorder.triggerTokens.append(token)
		return recorder.triggerResult
	}

	public static func isExternalProbeActive(_ label: String) -> Bool {
		recorder.probeActive
	}

	public static func captureExternalProbe(
		sdkVersion: String,
		service: String,
		environment: String,
		label: String,
		data: [String: Any?],
		occurredAt: String
	) -> Bool {
		recorder.externalProbes.append((
			sdkVersion,
			service,
			environment,
			label,
			data,
			occurredAt
		))
		return recorder.externalProbeResult
	}
}
