#import <Foundation/Foundation.h>

#include <memory>

@protocol NativeDebugBundleReactNativeSpec <NSObject>
@end

namespace facebook::react {

class TurboModule {
 public:
  virtual ~TurboModule() = default;
};

class ObjCTurboModule {
 public:
  struct InitParams {};
};

class NativeDebugBundleReactNativeSpecJSI final : public TurboModule {
 public:
  explicit NativeDebugBundleReactNativeSpecJSI(const ObjCTurboModule::InitParams &) {}
};

}
