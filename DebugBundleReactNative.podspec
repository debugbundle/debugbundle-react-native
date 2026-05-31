Pod::Spec.new do |s|
  s.name         = "DebugBundleReactNative"
  s.version      = "1.0.0"
  s.summary      = "React Native wrapper for the DebugBundle mobile SDKs."
  s.license      = { :type => "AGPL-3.0-only" }
  s.author       = { "DebugBundle" => "support@debugbundle.com" }
  s.homepage     = "https://github.com/debugbundle/debugbundle-react-native"
  s.source       = { :git => "https://github.com/debugbundle/debugbundle-react-native.git", :tag => s.version.to_s }
  s.platforms    = { :ios => "15.0" }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.10"

  s.dependency "React-Core"
  s.dependency "DebugBundle", "~> 1.0.0"
end
