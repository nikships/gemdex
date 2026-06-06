import Foundation
import SwiftUI

#if SPARKLE_ENABLED
import Sparkle
#endif

/// Wraps Sparkle's updater. Compiled with no-op fallbacks when Sparkle isn't
/// linked (local/dev builds), so the menu item just disables itself. The
/// signed release build (CI sets GEMDEX_SPARKLE=1) gets the real updater; the
/// feed URL + EdDSA public key are injected into Info.plist by embed-sparkle.sh.
@MainActor
final class UpdaterController: ObservableObject {
    @Published private(set) var canCheckForUpdates = false

    #if SPARKLE_ENABLED
    private let controller: SPUStandardUpdaterController

    init() {
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        canCheckForUpdates = true
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
    #else
    init() {
        canCheckForUpdates = false
    }

    func checkForUpdates() {}
    #endif
}
