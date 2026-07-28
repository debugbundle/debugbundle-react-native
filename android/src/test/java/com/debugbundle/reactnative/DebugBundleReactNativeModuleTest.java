package com.debugbundle.reactnative;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import com.debugbundle.android.DebugBundleConfig;
import com.debugbundle.android.DebugBundleLogLevel;
import com.debugbundle.android.DebugBundleRequestInfo;
import com.debugbundle.android.DebugBundleResponseInfo;
import com.facebook.react.bridge.Dynamic;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.uimanager.ViewManager;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;

public final class DebugBundleReactNativeModuleTest {
  private ReactApplicationContext reactContext;
  private Context applicationContext;
  private DebugBundleReactNativeModule.NativeOperations nativeOperations;
  private DebugBundleReactNativeModule.WritableMapFactory writableMapFactory;
  private WritableMap writableMap;
  private DebugBundleReactNativeModule module;

  @Before
  public void setUp() {
    reactContext = mock(ReactApplicationContext.class);
    applicationContext = mock(Context.class);
    nativeOperations = mock(DebugBundleReactNativeModule.NativeOperations.class);
    writableMapFactory = mock(DebugBundleReactNativeModule.WritableMapFactory.class);
    writableMap = mock(WritableMap.class);
    when(reactContext.getApplicationContext()).thenReturn(applicationContext);
    when(nativeOperations.statusName()).thenReturn("ONLINE");
    when(writableMapFactory.create()).thenReturn(writableMap);
    module = new DebugBundleReactNativeModule(
        reactContext,
        nativeOperations,
        writableMapFactory);
  }

  @Test
  public void initializesWithFullConfigurationAndReturnsNativeState() {
    when(nativeOperations.lastEventAt()).thenReturn(1_234L);
    Promise promise = mock(Promise.class);
    ReadableMap config = readableMap(Map.ofEntries(
        Map.entry("sdkVersion", "1.2.7"),
        Map.entry("projectToken", "project-token"),
        Map.entry("enabled", false),
        Map.entry("environment", "staging"),
        Map.entry("service", "checkout-mobile"),
        Map.entry("endpoint", "https://ingest.example.test"),
        Map.entry("batchSize", 4),
        Map.entry("flushInterval", 1_250.0),
        Map.entry("sampleRate", 0.5),
        Map.entry("sessionSampleRate", 0.75),
        Map.entry("requestTimeout", 2_500.0),
        Map.entry("releaseChannel", "beta"),
        Map.entry("appVersion", "4.2.0"),
        Map.entry("buildNumber", "42"),
        Map.entry("maxEventsPerSession", 55),
        Map.entry("maxBreadcrumbs", 12),
        Map.entry("captureScreens", false),
        Map.entry("captureActions", true),
        Map.entry("captureNetwork", false),
        Map.entry("captureLogs", false),
        Map.entry("logLevel", "debug"),
        Map.entry("headerAllowlist", List.of("x-request-id", 4)),
        Map.entry("offlineQueueMaxEvents", 75),
        Map.entry("offlineQueueMaxBytes", 4_096.0),
        Map.entry("offlineQueueTtl", 9_000.0),
        Map.entry("maxProbeLabels", 8),
        Map.entry("maxProbeEntriesPerLabel", 3),
        Map.entry("probeFlushOnError", false),
        Map.entry("redactFields", List.of("password"))));

    module.initialize(config, promise);

    verify(nativeOperations).initialize(eq(applicationContext), any(DebugBundleConfig.class));
    verify(writableMap).putString("status", "online");
    verify(writableMap).putDouble("lastEventAt", 1_234.0);
    verify(writableMap).putBoolean("nativeModuleAvailable", true);
    verify(writableMap).putNull("degradedReason");
    verify(promise).resolve(writableMap);
  }

  @Test
  public void initializationAndStatusFailOpenWithoutThrowingIntoReactNative() {
    Promise failedPromise = mock(Promise.class);
    doThrow(new IllegalStateException("native failure"))
        .when(nativeOperations)
        .initialize(any(Context.class), any(DebugBundleConfig.class));

    module.initialize(readableMap(Map.of()), failedPromise);

    verify(writableMap).putString("status", "degraded");
    verify(writableMap).putNull("lastEventAt");
    verify(writableMap).putString("degradedReason", "android_initialize_failed");
    verify(failedPromise).resolve(writableMap);

    reset(writableMap);
    when(nativeOperations.lastEventAt()).thenReturn(null);
    Promise statusPromise = mock(Promise.class);
    module.getStatus(statusPromise);
    verify(writableMap).putNull("lastEventAt");
    verify(statusPromise).resolve(writableMap);
  }

  @Test
  public void translatesEveryLegacyEventFamilyThroughNativeOperations() {
    assertLegacyEventCalls(
        Map.of(
            "event_type", "frontend_exception",
            "payload", Map.of("error", "checkout failed")),
        () -> verify(nativeOperations).captureException(
            any(RuntimeException.class),
            any(Map.class)));
    assertLegacyEventCalls(
        Map.of(
            "event_type", "frontend_breadcrumb",
            "payload", Map.of("breadcrumb_type", "screen_transition")),
        () -> verify(nativeOperations).captureBreadcrumb(
            eq("screen_transition"),
            isNull(),
            any(Map.class)));

    for (Map.Entry<String, DebugBundleLogLevel> entry : Map.of(
        "debug", DebugBundleLogLevel.Debug,
        "info", DebugBundleLogLevel.Info,
        "error", DebugBundleLogLevel.Error,
        "critical", DebugBundleLogLevel.Critical,
        "warning", DebugBundleLogLevel.Warning).entrySet()) {
      assertLegacyEventCalls(
          Map.of(
              "event_type", "log_event",
              "payload", Map.of("message", "checkout", "level", entry.getKey())),
          () -> verify(nativeOperations).captureLog(
              eq("checkout"),
              eq(entry.getValue()),
              any(Map.class)));
    }

    assertLegacyEventCalls(
        Map.of(
            "event_type", "request_event",
            "correlation", Map.of("trace_id", "trace-rn"),
            "payload", Map.of(
                "method", "POST",
                "url", "https://example.test/checkout",
                "route_template", "/checkout",
                "response_status", 503,
                "duration_ms", 12.5)),
        () -> verify(nativeOperations).captureRequest(
            any(DebugBundleRequestInfo.class),
            any(DebugBundleResponseInfo.class),
            any(Map.class),
            eq(false)));
    assertLegacyEventCalls(
        Map.of("event_type", "custom_event"),
        () -> verify(nativeOperations).captureMessage(
            eq("react_native_event:custom_event"),
            eq(DebugBundleLogLevel.Warning),
            any(Map.class)));
  }

  @Test
  public void canonicalEventsAndProbeOperationsReturnTruthfulResultsAndFailClosed() {
    ReadableMap event = readableMap(Map.of("event_type", "frontend_exception"));
    Promise canonicalPromise = mock(Promise.class);
    when(nativeOperations.captureExternalEvent(any(Map.class))).thenReturn(true);
    module.enqueueCanonicalEvent(event, canonicalPromise);
    verify(canonicalPromise).resolve(true);

    when(nativeOperations.isProbeActive("checkout.*")).thenReturn(true);
    assertTrue(module.isProbeActive("checkout.*"));
    doThrow(new IllegalStateException("probe failure"))
        .when(nativeOperations)
        .isProbeActive("broken");
    assertFalse(module.isProbeActive("broken"));

    Promise initializePromise = mock(Promise.class);
    module.initialize(
        readableMap(Map.of(
            "sdkVersion", "1.2.7",
            "service", "checkout-mobile",
            "environment", "test")),
        initializePromise);
    Promise probePromise = mock(Promise.class);
    when(nativeOperations.captureExternalProbe(
        anyString(),
        anyString(),
        anyString(),
        anyString(),
        any(Map.class),
        anyString())).thenReturn(true);
    module.captureProbe(
        "checkout.cart",
        readableMap(Map.of("count", 2)),
        "2026-07-28T12:00:00.000Z",
        probePromise);
    verify(nativeOperations).captureExternalProbe(
        "1.2.7",
        "checkout-mobile",
        "test",
        "checkout.cart",
        Map.of("count", 2),
        "2026-07-28T12:00:00.000Z");
    verify(probePromise).resolve(true);

    Promise failedCanonicalPromise = mock(Promise.class);
    doThrow(new IllegalStateException("capture failure"))
        .when(nativeOperations)
        .captureExternalEvent(any(Map.class));
    module.enqueueCanonicalEvent(event, failedCanonicalPromise);
    verify(failedCanonicalPromise).resolve(false);

    Promise failedProbePromise = mock(Promise.class);
    doThrow(new IllegalStateException("probe capture failure"))
        .when(nativeOperations)
        .captureExternalProbe(anyString(), anyString(), anyString(), anyString(), any(Map.class), anyString());
    module.captureProbe(
        "checkout.cart",
        readableMap(Map.of()),
        "2026-07-28T12:00:00.000Z",
        failedProbePromise);
    verify(failedProbePromise).resolve(false);
  }

  @Test
  public void contextTriggerAndFlushOperationsAlwaysResolve() throws Exception {
    Promise contextPromise = mock(Promise.class);
    Dynamic tenant = dynamic(ReadableType.String, "checkout");
    module.setContext("tenant", tenant, contextPromise);
    verify(nativeOperations).setContext("tenant", "checkout");
    verify(tenant).recycle();
    verify(contextPromise).resolve(isNull());

    Promise contextValuePromise = mock(Promise.class);
    module.setContextValue(
        "cart",
        readableMap(Map.of("value", 2)),
        contextValuePromise);
    verify(nativeOperations).setContext("cart", 2);
    verify(contextValuePromise).resolve(isNull());

    Promise triggerPromise = mock(Promise.class);
    when(nativeOperations.activateProbeTriggerToken("trigger")).thenReturn(true);
    module.activateProbeTriggerToken("trigger", triggerPromise);
    verify(triggerPromise).resolve(true);

    Promise flushPromise = mock(Promise.class);
    module.flush(flushPromise);
    verify(nativeOperations).flush();
    verify(flushPromise).resolve(isNull());

    doThrow(new IllegalStateException("context failure"))
        .when(nativeOperations)
        .setContext(eq("broken"), any());
    Promise failedContext = mock(Promise.class);
    Dynamic failedValue = dynamic(ReadableType.String, "value");
    module.setContext("broken", failedValue, failedContext);
    verify(failedValue).recycle();
    verify(failedContext).resolve(isNull());

    doThrow(new ReflectiveOperationException("flush failure"))
        .when(nativeOperations)
        .flush();
    Promise failedFlush = mock(Promise.class);
    module.flush(failedFlush);
    verify(failedFlush).resolve(isNull());

    doThrow(new IllegalStateException("trigger failure"))
        .when(nativeOperations)
        .activateProbeTriggerToken("broken");
    Promise failedTrigger = mock(Promise.class);
    module.activateProbeTriggerToken("broken", failedTrigger);
    verify(failedTrigger).resolve(false);
  }

  @Test
  public void legacyDynamicContextPreservesEverySupportedValueShape() {
    assertDynamicContext("null", dynamic(ReadableType.Null, null), null);
    assertDynamicContext("boolean", dynamic(ReadableType.Boolean, true), true);
    assertDynamicContext("number", dynamic(ReadableType.Number, 2.5), 2.5);
    assertDynamicContext("string", dynamic(ReadableType.String, "checkout"), "checkout");
    assertDynamicContext(
        "map",
        dynamic(ReadableType.Map, readableMap(Map.of("count", 2))),
        Map.of("count", 2));
    assertDynamicContext(
        "array",
        dynamic(ReadableType.Array, readableArray(List.of("cart", 2))),
        List.of("cart", 2));
  }

  @Test
  public void legacyTranslationFailureIsSwallowedAndModuleNameIsStable() {
    Promise promise = mock(Promise.class);
    doThrow(new IllegalStateException("legacy failure"))
        .when(nativeOperations)
        .captureMessage(anyString(), any(DebugBundleLogLevel.class), any(Map.class));

    module.enqueueEvent(readableMap(Map.of("event_type", "custom_event")), promise);

    verify(promise).resolve(isNull());
    verify(promise, never()).reject(anyString(), anyString());
    org.junit.Assert.assertEquals(DebugBundleReactNativeModule.NAME, module.getName());
  }

  @Test
  public void reactPackageRegistersOneModuleAndNoViewManagers() {
    DebugBundleReactNativePackage reactPackage = new DebugBundleReactNativePackage();

    List<NativeModule> modules = reactPackage.createNativeModules(reactContext);
    List<ViewManager> viewManagers = reactPackage.createViewManagers(reactContext);

    org.junit.Assert.assertEquals(1, modules.size());
    org.junit.Assert.assertEquals(DebugBundleReactNativeModule.NAME, modules.get(0).getName());
    assertTrue(viewManagers.isEmpty());
  }

  @Test
  public void newArchitectureInteropCanParseEveryExportedMethod() throws Exception {
    Class<?> interop = Class.forName(
        "com.facebook.react.internal.turbomodule.core.TurboModuleInteropUtils");
    java.lang.reflect.Method parser = interop.getDeclaredMethod(
        "getMethodDescriptorsFromModule",
        NativeModule.class);
    parser.setAccessible(true);

    List<?> descriptors = (List<?>) parser.invoke(null, module);

    assertFalse(descriptors.isEmpty());
  }

  private void assertLegacyEventCalls(
      Map<String, Object> event,
      Runnable verification) {
    Promise promise = mock(Promise.class);
    module.enqueueEvent(readableMap(event), promise);
    verification.run();
    verify(promise).resolve(isNull());
  }

  private void assertDynamicContext(String key, Dynamic value, Object expected) {
    Promise promise = mock(Promise.class);
    module.setContext(key, value, promise);
    verify(nativeOperations).setContext(key, expected);
    verify(value).recycle();
    verify(promise).resolve(isNull());
  }

  private static Dynamic dynamic(ReadableType type, Object value) {
    Dynamic dynamic = mock(Dynamic.class);
    when(dynamic.getType()).thenReturn(type);
    when(dynamic.isNull()).thenReturn(type == ReadableType.Null);
    switch (type) {
      case Boolean:
        when(dynamic.asBoolean()).thenReturn((Boolean) value);
        break;
      case Number:
        when(dynamic.asDouble()).thenReturn((Double) value);
        break;
      case String:
        when(dynamic.asString()).thenReturn((String) value);
        break;
      case Map:
        when(dynamic.asMap()).thenReturn((ReadableMap) value);
        break;
      case Array:
        when(dynamic.asArray()).thenReturn((ReadableArray) value);
        break;
      default:
        break;
    }
    return dynamic;
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private static ReadableArray readableArray(List<?> values) {
    ReadableArray array = mock(ReadableArray.class);
    when(array.toArrayList()).thenReturn((java.util.ArrayList) new java.util.ArrayList<>((List) values));
    return array;
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private static ReadableMap readableMap(Map<String, ?> values) {
    Map<String, Object> copy = new HashMap<>((Map) values);
    ReadableMap readableMap = mock(ReadableMap.class);
    when(readableMap.hasKey(anyString()))
        .thenAnswer(invocation -> copy.containsKey(invocation.getArgument(0)));
    when(readableMap.isNull(anyString()))
        .thenAnswer(invocation -> copy.get(invocation.getArgument(0)) == null);
    when(readableMap.getString(anyString()))
        .thenAnswer(invocation -> (String) copy.get(invocation.getArgument(0)));
    when(readableMap.getBoolean(anyString()))
        .thenAnswer(invocation -> (Boolean) copy.get(invocation.getArgument(0)));
    when(readableMap.getInt(anyString()))
        .thenAnswer(invocation -> ((Number) copy.get(invocation.getArgument(0))).intValue());
    when(readableMap.getDouble(anyString()))
        .thenAnswer(invocation -> ((Number) copy.get(invocation.getArgument(0))).doubleValue());
    when(readableMap.getMap(anyString()))
        .thenAnswer(invocation -> {
          Object value = copy.get(invocation.getArgument(0));
          if (value instanceof ReadableMap) {
            return value;
          }
          if (value instanceof Map) {
            return readableMap((Map<String, ?>) value);
          }
          return null;
        });
    when(readableMap.getArray(anyString()))
        .thenAnswer(invocation -> {
          Object value = copy.get(invocation.getArgument(0));
          if (!(value instanceof List)) {
            return null;
          }
          ReadableArray array = mock(ReadableArray.class);
          when(array.toArrayList()).thenReturn((java.util.ArrayList) new java.util.ArrayList<>((List) value));
          return array;
        });
    when(readableMap.toHashMap()).thenReturn(new HashMap<>(copy));
    return readableMap;
  }
}
