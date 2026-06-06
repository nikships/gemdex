// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Sparkle is linked only for signed release builds (CI sets GEMDEX_SPARKLE=1 and
// vendors Sparkle.framework under third_party/sparkle). Local/dev builds — and
// the screenshot/smoke runs — build without it so no framework is required.
let sparkleEnabled = ProcessInfo.processInfo.environment["GEMDEX_SPARKLE"] == "1"

var swiftSettings: [SwiftSetting] = []
var linkerSettings: [LinkerSetting] = []

if sparkleEnabled {
    swiftSettings.append(.define("SPARKLE_ENABLED"))
    swiftSettings.append(.unsafeFlags(["-F", "third_party/sparkle"]))
    linkerSettings.append(.unsafeFlags([
        "-F", "third_party/sparkle",
        "-framework", "Sparkle",
        "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
    ]))
}

let package = Package(
    name: "GemdexMemory",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "GemdexMemory",
            path: "Sources/GemdexMemory",
            swiftSettings: swiftSettings,
            linkerSettings: linkerSettings
        )
    ]
)
