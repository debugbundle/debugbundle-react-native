package com.debugbundle.reactnative;

import android.content.Context;
import com.debugbundle.android.DebugBundle;
import com.debugbundle.android.DebugBundleConfig;
import com.debugbundle.android.DebugBundleLogLevel;
import com.debugbundle.android.DebugBundleRequestInfo;
import com.debugbundle.android.DebugBundleResponseInfo;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Dynamic;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class DebugBundleReactNativeModule extends ReactContextBaseJavaModule {
  public static final String NAME = "DebugBundleReactNative";

  private final ReactApplicationContext reactContext;
  private final NativeOperations nativeOperations;
  private final WritableMapFactory writableMapFactory;

  public DebugBundleReactNativeModule(ReactApplicationContext reactContext) {
    this(reactContext, new DefaultNativeOperations(), Arguments::createMap);
  }

  DebugBundleReactNativeModule(
      ReactApplicationContext reactContext,
      NativeOperations nativeOperations,
      WritableMapFactory writableMapFactory) {
    super(reactContext);
    this.reactContext = reactContext;
    this.nativeOperations = nativeOperations;
    this.writableMapFactory = writableMapFactory;
  }

  @Override
  public String getName() {
    return NAME;
  }

  @ReactMethod
  public void initialize(ReadableMap config, Promise promise) {
    try {
      nativeOperations.initialize(reactContext.getApplicationContext(), createConfig(config));
      promise.resolve(stateMap());
    } catch (Throwable ignored) {
      promise.resolve(degradedState("android_initialize_failed"));
    }
  }

  @ReactMethod
  public void enqueueEvent(ReadableMap event, Promise promise) {
    try {
      String eventType = stringOrDefault(event, "event_type", "");
      Map<String, Object> payload = hashMap(event, "payload");

      if ("frontend_exception".equals(eventType)) {
        nativeOperations.captureException(
            new RuntimeException(stringValue(payload.get("error"), "React Native exception")),
            payload);
      } else if ("frontend_breadcrumb".equals(eventType)) {
        nativeOperations.captureBreadcrumb(
            stringValue(payload.get("breadcrumb_type"), "react_native"),
            null,
            payload);
      } else if ("log_event".equals(eventType)) {
        nativeOperations.captureLog(
            stringValue(payload.get("message"), ""),
            logLevel(stringValue(payload.get("level"), null)),
            payload);
      } else if ("request_event".equals(eventType)) {
        ReadableMap correlation = event.hasKey("correlation") ? event.getMap("correlation") : null;
        nativeOperations.captureRequest(
            new DebugBundleRequestInfo(
                stringValue(payload.get("method"), "GET"),
                stringValue(payload.get("url"), ""),
                Collections.emptyMap(),
                stringValue(payload.get("route_template"), null),
                correlation == null ? null : correlation.getString("trace_id")),
            new DebugBundleResponseInfo(
                intValue(payload.get("response_status"), 0),
                longValue(payload.get("duration_ms")),
                Collections.emptyMap()),
            payload,
            false);
      } else {
        nativeOperations.captureMessage(
            "react_native_event:" + eventType,
            DebugBundleLogLevel.Warning,
            payload);
      }
      promise.resolve(null);
    } catch (Throwable ignored) {
      promise.resolve(null);
    }
  }

  /**
   * Canonical bridge added after the original translation-based enqueue API.
   * The legacy method above remains available for installed JS/native pairs.
   */
  @ReactMethod
  public void enqueueCanonicalEvent(ReadableMap event, Promise promise) {
    try {
      promise.resolve(
          nativeOperations.captureExternalEvent(normalizeBridgeMap(event.toHashMap())));
    } catch (Throwable ignored) {
      promise.resolve(false);
    }
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean isProbeActive(String label) {
    try {
      return nativeOperations.isProbeActive(label);
    } catch (Throwable ignored) {
      return false;
    }
  }

  @ReactMethod
  public void captureProbe(
      String label,
      ReadableMap data,
      String occurredAt,
      Promise promise) {
    try {
      promise.resolve(nativeOperations.captureExternalProbe(
          currentSdkVersion,
          currentService,
          currentEnvironment,
          label,
          data.toHashMap(),
          occurredAt));
    } catch (Throwable ignored) {
      promise.resolve(false);
    }
  }

  @ReactMethod
  public void flush(Promise promise) {
    try {
      nativeOperations.flush();
      promise.resolve(null);
    } catch (Throwable ignored) {
      promise.resolve(null);
    }
  }

  @ReactMethod
  public void getStatus(Promise promise) {
    promise.resolve(stateMap());
  }

  @ReactMethod
  public void setContext(String key, Dynamic value, Promise promise) {
    try {
      nativeOperations.setContext(key, dynamicValue(value));
      promise.resolve(null);
    } catch (Throwable ignored) {
      promise.resolve(null);
    } finally {
      try {
        value.recycle();
      } catch (Throwable ignored) {
        // React Native bridge cleanup must not escape into the host process.
      }
    }
  }

  @ReactMethod
  public void setContextValue(String key, ReadableMap entry, Promise promise) {
    try {
      nativeOperations.setContext(key, entry.toHashMap().get("value"));
      promise.resolve(null);
    } catch (Throwable ignored) {
      promise.resolve(null);
    }
  }

  @ReactMethod
  public void activateProbeTriggerToken(String token, Promise promise) {
    try {
      promise.resolve(nativeOperations.activateProbeTriggerToken(token));
    } catch (Throwable ignored) {
      promise.resolve(false);
    }
  }

  private String currentSdkVersion = "1.2.0";
  private String currentService = "react-native-app";
  private String currentEnvironment = "production";

  private DebugBundleConfig createConfig(ReadableMap config) {
    currentSdkVersion = stringOrDefault(config, "sdkVersion", "1.2.0");
    currentService = stringOrDefault(config, "service", "react-native-app");
    currentEnvironment = stringOrDefault(config, "environment", "production");
    return DebugBundleConfig.create(
        stringOrDefault(config, "projectToken", ""),
        booleanOrDefault(config, "enabled", true),
        currentEnvironment,
        currentService,
        stringOrDefault(config, "endpoint", DebugBundleConfig.DEFAULT_ENDPOINT),
        intOrDefault(config, "batchSize", 10),
        longOrDefault(config, "flushInterval", 3000L),
        doubleOrDefault(config, "sampleRate", 1.0),
        doubleOrDefault(config, "sessionSampleRate", 1.0),
        longOrDefault(config, "requestTimeout", 5000L),
        stringOrDefault(config, "releaseChannel", "production"),
        stringOrNull(config, "appVersion"),
        stringOrNull(config, "buildNumber"),
        intOrDefault(config, "maxEventsPerSession", 100),
        intOrDefault(config, "maxBreadcrumbs", 20),
        booleanOrDefault(config, "captureScreens", true),
        booleanOrDefault(config, "captureActions", false),
        booleanOrDefault(config, "captureNetwork", true),
        booleanOrDefault(config, "captureLogs", true),
        logLevel(stringOrNull(config, "logLevel")),
        stringSet(config, "headerAllowlist", Collections.emptySet()),
        intOrDefault(config, "offlineQueueMaxEvents", 500),
        longOrDefault(config, "offlineQueueMaxBytes", 5L * 1024L * 1024L),
        longOrDefault(config, "offlineQueueTtl", 72L * 60L * 60L * 1000L),
        intOrDefault(config, "maxProbeLabels", 50),
        intOrDefault(config, "maxProbeEntriesPerLabel", 10),
        booleanOrDefault(config, "probeFlushOnError", true),
        stringSet(config, "redactFields", Collections.emptySet()),
        currentSdkVersion);
  }

  private WritableMap stateMap() {
    WritableMap state = writableMapFactory.create();
    state.putString("status", nativeOperations.statusName().toLowerCase(Locale.ROOT));
    Long lastEventAt = nativeOperations.lastEventAt();
    if (lastEventAt == null) {
      state.putNull("lastEventAt");
    } else {
      state.putDouble("lastEventAt", lastEventAt.doubleValue());
    }
    state.putBoolean("nativeModuleAvailable", true);
    state.putNull("degradedReason");
    return state;
  }

  private WritableMap degradedState(String reason) {
    WritableMap state = writableMapFactory.create();
    state.putString("status", "degraded");
    state.putNull("lastEventAt");
    state.putBoolean("nativeModuleAvailable", true);
    state.putString("degradedReason", reason);
    return state;
  }

  private static Map<String, Object> hashMap(ReadableMap map, String key) {
    ReadableMap nested = map.hasKey(key) ? map.getMap(key) : null;
    if (nested == null) {
      return Collections.emptyMap();
    }
    return nested.toHashMap();
  }

  private static String stringOrDefault(ReadableMap map, String key, String fallback) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return fallback;
    }
    String value = map.getString(key);
    return value == null ? fallback : value;
  }

  private static String stringOrNull(ReadableMap map, String key) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return null;
    }
    return map.getString(key);
  }

  private static boolean booleanOrDefault(ReadableMap map, String key, boolean fallback) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return fallback;
    }
    return map.getBoolean(key);
  }

  private static int intOrDefault(ReadableMap map, String key, int fallback) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return fallback;
    }
    return map.getInt(key);
  }

  private static long longOrDefault(ReadableMap map, String key, long fallback) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return fallback;
    }
    return (long) map.getDouble(key);
  }

  private static double doubleOrDefault(ReadableMap map, String key, double fallback) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return fallback;
    }
    return map.getDouble(key);
  }

  private static Set<String> stringSet(
      ReadableMap map,
      String key,
      Set<String> fallback) {
    if (!map.hasKey(key) || map.isNull(key) || map.getArray(key) == null) {
      return fallback;
    }
    List<Object> values = map.getArray(key).toArrayList();
    Set<String> result = new HashSet<>();
    for (Object value : values) {
      if (value instanceof String) {
        result.add((String) value);
      }
    }
    return result;
  }

  private static String stringValue(Object value, String fallback) {
    return value == null ? fallback : value.toString();
  }

  private static int intValue(Object value, int fallback) {
    return value instanceof Number ? ((Number) value).intValue() : fallback;
  }

  private static Long longValue(Object value) {
    return value instanceof Number ? ((Number) value).longValue() : null;
  }

  private static Map<String, Object> normalizeBridgeMap(Map<String, Object> values) {
    Map<String, Object> normalized = new LinkedHashMap<>();
    for (Map.Entry<String, Object> entry : values.entrySet()) {
      normalized.put(entry.getKey(), normalizeBridgeValue(entry.getValue()));
    }
    return normalized;
  }

  private static Object normalizeBridgeValue(Object value) {
    if (value instanceof Double) {
      double number = (Double) value;
      if (Double.isFinite(number)
          && number == Math.rint(number)
          && number >= Long.MIN_VALUE
          && number <= Long.MAX_VALUE) {
        return (long) number;
      }
      return number;
    }
    if (value instanceof Map<?, ?>) {
      Map<String, Object> normalized = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        if (entry.getKey() instanceof String) {
          normalized.put(
              (String) entry.getKey(),
              normalizeBridgeValue(entry.getValue()));
        }
      }
      return normalized;
    }
    if (value instanceof List<?>) {
      List<Object> normalized = new ArrayList<>();
      for (Object item : (List<?>) value) {
        normalized.add(normalizeBridgeValue(item));
      }
      return normalized;
    }
    return value;
  }

  private static Object dynamicValue(Dynamic value) {
    if (value == null || value.isNull()) {
      return null;
    }
    switch (value.getType()) {
      case Boolean:
        return value.asBoolean();
      case Number:
        return value.asDouble();
      case String:
        return value.asString();
      case Map:
        return value.asMap().toHashMap();
      case Array:
        return value.asArray().toArrayList();
      default:
        return null;
    }
  }

  private static DebugBundleLogLevel logLevel(String value) {
    if (value == null) {
      return DebugBundleLogLevel.Warning;
    }
    switch (value.toLowerCase(Locale.ROOT)) {
      case "debug":
        return DebugBundleLogLevel.Debug;
      case "info":
        return DebugBundleLogLevel.Info;
      case "error":
        return DebugBundleLogLevel.Error;
      case "critical":
        return DebugBundleLogLevel.Critical;
      default:
        return DebugBundleLogLevel.Warning;
    }
  }

  interface WritableMapFactory {
    WritableMap create();
  }

  interface NativeOperations {
    void initialize(Context context, DebugBundleConfig config);

    void captureException(Throwable error, Map<String, Object> context);

    void captureBreadcrumb(String type, String route, Map<String, Object> data);

    void captureLog(
        String message,
        DebugBundleLogLevel level,
        Map<String, Object> context);

    void captureRequest(
        DebugBundleRequestInfo request,
        DebugBundleResponseInfo response,
        Map<String, Object> context,
        boolean force);

    void captureMessage(
        String message,
        DebugBundleLogLevel level,
        Map<String, Object> context);

    boolean captureExternalEvent(Map<String, Object> event);

    boolean isProbeActive(String label);

    boolean captureExternalProbe(
        String sdkVersion,
        String service,
        String environment,
        String label,
        Map<String, Object> data,
        String occurredAt);

    void flush() throws ReflectiveOperationException;

    void setContext(String key, Object value);

    boolean activateProbeTriggerToken(String token);

    String statusName();

    Long lastEventAt();
  }

  private static final class DefaultNativeOperations implements NativeOperations {
    @Override
    public void initialize(Context context, DebugBundleConfig config) {
      DebugBundle.init(context, config);
    }

    @Override
    public void captureException(Throwable error, Map<String, Object> context) {
      DebugBundle.INSTANCE.captureException(error, context);
    }

    @Override
    public void captureBreadcrumb(String type, String route, Map<String, Object> data) {
      DebugBundle.INSTANCE.captureBreadcrumb(type, route, data);
    }

    @Override
    public void captureLog(
        String message,
        DebugBundleLogLevel level,
        Map<String, Object> context) {
      DebugBundle.INSTANCE.captureLog(message, level, context);
    }

    @Override
    public void captureRequest(
        DebugBundleRequestInfo request,
        DebugBundleResponseInfo response,
        Map<String, Object> context,
        boolean force) {
      DebugBundle.INSTANCE.captureRequest(request, response, context, force);
    }

    @Override
    public void captureMessage(
        String message,
        DebugBundleLogLevel level,
        Map<String, Object> context) {
      DebugBundle.INSTANCE.captureMessage(message, level, context);
    }

    @Override
    public boolean captureExternalEvent(Map<String, Object> event) {
      return DebugBundle.captureExternalEvent(event);
    }

    @Override
    public boolean isProbeActive(String label) {
      return DebugBundle.isExternalProbeActive(label);
    }

    @Override
    public boolean captureExternalProbe(
        String sdkVersion,
        String service,
        String environment,
        String label,
        Map<String, Object> data,
        String occurredAt) {
      return DebugBundle.captureExternalProbe(
          sdkVersion,
          service,
          environment,
          label,
          data,
          occurredAt);
    }

    @Override
    public void flush() throws ReflectiveOperationException {
      Method flushDefault = DebugBundle.class.getDeclaredMethod(
          "flush-LRDsOJo$default",
          DebugBundle.class,
          long.class,
          int.class,
          Object.class);
      flushDefault.invoke(null, DebugBundle.INSTANCE, 0L, 1, null);
    }

    @Override
    public void setContext(String key, Object value) {
      DebugBundle.INSTANCE.setContext(key, value);
    }

    @Override
    public boolean activateProbeTriggerToken(String token) {
      return DebugBundle.INSTANCE.activateProbeTriggerToken(token);
    }

    @Override
    public String statusName() {
      return DebugBundle.INSTANCE.getStatus().name();
    }

    @Override
    public Long lastEventAt() {
      return DebugBundle.INSTANCE.getLastEventAt();
    }
  }
}
