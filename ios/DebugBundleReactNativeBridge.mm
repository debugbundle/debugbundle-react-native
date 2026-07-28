#import <React/RCTBridgeModule.h>

#if defined(RCT_NEW_ARCH_ENABLED) || defined(RCT_REMOVE_LEGACY_ARCH)
#if __has_include(<ReactCodegen/DebugBundleReactNativeSpec/DebugBundleReactNativeSpec.h>)
#import <ReactCodegen/DebugBundleReactNativeSpec/DebugBundleReactNativeSpec.h>
#elif __has_include(<ReactCodegen/DebugBundleReactNativeSpec.h>)
#import <ReactCodegen/DebugBundleReactNativeSpec.h>
#else
#error "DebugBundle React Native codegen header was not generated"
#endif
#endif

@interface RCT_EXTERN_MODULE(DebugBundleReactNative, NSObject)

RCT_EXTERN_METHOD(initialize:(NSDictionary *)config
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(enqueueEvent:(NSDictionary *)event
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(enqueueCanonicalEvent:(NSDictionary *)event
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(flush:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getStatus:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setContext:(NSString *)key
                  value:(id)value
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setContextValue:(NSString *)key
                  entry:(NSDictionary *)entry
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(activateProbeTriggerToken:(NSString *)token
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(isProbeActive:(NSString *)label)

RCT_EXTERN_METHOD(captureProbe:(NSString *)label
                  data:(NSDictionary *)data
                  occurredAt:(NSString *)occurredAt
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end

#if defined(RCT_NEW_ARCH_ENABLED) || defined(RCT_REMOVE_LEGACY_ARCH)
@interface DebugBundleReactNative (NativeDebugBundleReactNativeSpecConformance) <NativeDebugBundleReactNativeSpec>
@end

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wprotocol"
@implementation DebugBundleReactNative (NativeDebugBundleReactNativeSpecConformance)

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeDebugBundleReactNativeSpecJSI>(params);
}

@end
#pragma clang diagnostic pop
#endif
