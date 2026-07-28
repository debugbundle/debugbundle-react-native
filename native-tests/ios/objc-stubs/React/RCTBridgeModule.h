#import <Foundation/Foundation.h>

typedef void (^RCTPromiseResolveBlock)(id result);
typedef void (^RCTPromiseRejectBlock)(NSString *code, NSString *message, NSError *error);

#define RCT_EXTERN_MODULE(objc_name, objc_supername) objc_name : objc_supername
#define RCT_EXTERN_METHOD(method)
#define RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(method)
