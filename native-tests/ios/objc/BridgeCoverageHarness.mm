#import <Foundation/Foundation.h>

#define RCT_NEW_ARCH_ENABLED 1
#include "../../../ios/DebugBundleReactNativeBridge.mm"

@implementation DebugBundleReactNative
@end

int main() {
	@autoreleasepool {
		DebugBundleReactNative *module = [DebugBundleReactNative new];
		facebook::react::ObjCTurboModule::InitParams params;
		std::shared_ptr<facebook::react::TurboModule> turboModule =
			[module getTurboModule:params];
		return turboModule == nullptr ? 1 : 0;
	}
}
