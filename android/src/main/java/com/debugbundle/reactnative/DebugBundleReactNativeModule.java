package com.debugbundle.reactnative;

import com.debugbundle.android.DebugBundle;
import com.debugbundle.android.DebugBundleConfig;
import com.debugbundle.android.DebugBundleLogLevel;
import com.debugbundle.android.DebugBundleRequestInfo;
import com.debugbundle.android.DebugBundleResponseInfo;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;

public final class DebugBundleReactNativeModule extends ReactContextBaseJavaModule {
  public static final String NAME = "DebugBundleReactNative";

  private final ReactApplicationContext reactContext;

  public DebugBundleReactNativeModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Override
  public String getName() {
    return NAME;
  }

  @ReactMethod
  public void initialize(ReadableMap config, Promise promise) {
    try {
      DebugBundle.init(reactContext.getApplicationContext(), createConfig(config));
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
      DebugBundle debugBundle = DebugBundle.INSTANCE;

      if ("frontend_exception".equals(eventType)) {
        debugBundle.captureException(
            new RuntimeException(stringValue(payload.get("error"), "React Native exception")),
            payload);
      } else if ("frontend_breadcrumb".equals(eventType)) {
        debugBundle.captureBreadcrumb(
            stringValue(payload.get("breadcrumb_type"), "react_native"),
            null,
            payload);
      } else if ("log_event".equals(eventType)) {
        debugBundle.captureLog(
            stringValue(payload.get("message"), ""),
            logLevel(stringValue(payload.get("level"), null)),
            payload);
      } else if ("request_event".equals(eventType)) {
        ReadableMap correlation = event.hasKey("correlation") ? event.getMap("correlation") : null;
        debugBundle.captureRequest(
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
        debugBundle.captureMessage(
            "react_native_event:" + eventType,
            DebugBundleLogLevel.Warning,
            payload);
      }
      promise.resolve(null);
    } catch (Throwable ignored) {
      promise.resolve(null);
    }
  }

  @ReactMethod
  public void flush(Promise promise) {
    try {
      Method flushDefault = DebugBundle.class.getDeclaredMethod(
          "flush-LRDsOJo$default",
          DebugBundle.class,
          long.class,
          int.class,
          Object.class);
      flushDefault.invoke(null, DebugBundle.INSTANCE, 0L, 1, null);
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
  public void setContext(String key, Object value, Promise promise) {
    try {
      DebugBundle.INSTANCE.setContext(key, value);
      promise.resolve(null);
    } catch (Throwable ignored) {
      promise.resolve(null);
    }
  }

  @ReactMethod
  public void activateProbeTriggerToken(String token, Promise promise) {
    try {
      promise.resolve(DebugBundle.INSTANCE.activateProbeTriggerToken(token));
    } catch (Throwable ignored) {
      promise.resolve(false);
    }
  }

  private DebugBundleConfig createConfig(ReadableMap config) throws ReflectiveOperationException {
    Constructor<?> constructor = null;
    for (Constructor<?> candidate : DebugBundleConfig.class.getDeclaredConstructors()) {
      if (candidate.getParameterTypes().length == 34) {
        constructor = candidate;
        break;
      }
    }
    if (constructor == null) {
      throw new NoSuchMethodException("DebugBundleConfig default constructor");
    }
    constructor.setAccessible(true);

    int mask = -1;
    mask = useProvided(mask, 0);
    mask = useProvided(mask, 1);
    mask = useProvided(mask, 2);
    mask = useProvided(mask, 3);
    mask = useProvided(mask, 4);
    mask = useProvided(mask, 10);
    mask = useProvided(mask, 11);
    mask = useProvided(mask, 12);
    mask = useProvided(mask, 31);

    return (DebugBundleConfig) constructor.newInstance(
        stringOrDefault(config, "projectToken", ""),
        booleanOrDefault(config, "enabled", true),
        stringOrDefault(config, "environment", "production"),
        stringOrDefault(config, "service", "react-native-app"),
        stringOrDefault(config, "endpoint", DebugBundleConfig.DEFAULT_ENDPOINT),
        0,
        0L,
        0.0,
        0.0,
        0L,
        stringOrDefault(config, "releaseChannel", "production"),
        stringOrNull(config, "appVersion"),
        stringOrNull(config, "buildNumber"),
        0,
        0,
        false,
        false,
        false,
        false,
        DebugBundleLogLevel.Warning,
        false,
        Collections.emptySet(),
        0,
        0L,
        0L,
        null,
        null,
        0,
        0,
        false,
        Collections.emptySet(),
        stringOrDefault(config, "sdkVersion", "1.1.0"),
        mask,
        null);
  }

  private WritableMap stateMap() {
    WritableMap state = Arguments.createMap();
    state.putString("status", DebugBundle.INSTANCE.getStatus().name().toLowerCase(Locale.ROOT));
    Long lastEventAt = DebugBundle.INSTANCE.getLastEventAt();
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
    WritableMap state = Arguments.createMap();
    state.putString("status", "degraded");
    state.putNull("lastEventAt");
    state.putBoolean("nativeModuleAvailable", true);
    state.putString("degradedReason", reason);
    return state;
  }

  private static int useProvided(int mask, int index) {
    return mask & ~(1 << index);
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

  private static String stringValue(Object value, String fallback) {
    return value == null ? fallback : value.toString();
  }

  private static int intValue(Object value, int fallback) {
    return value instanceof Number ? ((Number) value).intValue() : fallback;
  }

  private static Long longValue(Object value) {
    return value instanceof Number ? ((Number) value).longValue() : null;
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
}
