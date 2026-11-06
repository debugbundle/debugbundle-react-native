export const iosSceneManifestFragment = `  <key>UIApplicationSceneManifest</key>
  <dict>
    <key>UIApplicationSupportsMultipleScenes</key>
    <false/>
    <key>UISceneConfigurations</key>
    <dict>
      <key>UIWindowSceneSessionRoleApplication</key>
      <array>
        <dict>
          <key>UISceneConfigurationName</key>
          <string>Default Configuration</string>
          <key>UISceneDelegateClassName</key>
          <string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
        </dict>
      </array>
    </dict>
  </dict>`;

export function renderIosRuntimeAppDelegate(projectName) {
  return `import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

${renderSceneDelegate(projectName)}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;
}

function renderSceneDelegate(moduleName, includeAppWindow = false) {
  return `class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
${includeAppWindow ? "    appDelegate.window = window\n" : ""}    factory.startReactNative(
      withModuleName: "${moduleName}",
      in: window,
      launchOptions: nil
    )
  }
}
`;
}

// Expo's generated classic window does not launch JS on the iOS 27 scene lifecycle.
// Adapt only the disposable runtime app, retaining Expo's factory and subscribers.
export function renderExpoIosRuntimeAppDelegate(source) {
  if (source.includes("class SceneDelegate: UIResponder, UIWindowSceneDelegate")) return source;
  const startup = /#if os\(iOS\) \|\| os\(tvOS\)\n[ \t]*window = UIWindow\(frame: UIScreen\.main\.bounds\)[\s\S]*?#endif/;
  if (!source.includes("class AppDelegate: ExpoAppDelegate") || !startup.test(source) ||
      !source.includes("  // Linking API") || !source.includes("\nclass ReactNativeDelegate:")) {
    throw new Error("Unsupported Expo runtime template");
  }
  const configuration = `  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

`;
  return source.replace(startup, "")
    .replace("  // Linking API", `${configuration}  // Linking API`)
    .replace("\nclass ReactNativeDelegate:", `\n${renderSceneDelegate("main", true)}\nclass ReactNativeDelegate:`);
}
