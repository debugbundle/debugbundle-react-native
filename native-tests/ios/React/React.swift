import Foundation

public typealias RCTPromiseResolveBlock = @convention(block) (Any?) -> Void
public typealias RCTPromiseRejectBlock = @convention(block) (String?, String?, Error?) -> Void
