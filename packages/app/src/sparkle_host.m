// Sparkle integration for the Gemdex Memory shell.
//
// zero-native owns the AppKit lifecycle; it fires its START event on the main
// thread right before `[NSApp run]`, which maps to the Zig `App.start`
// callback. We hook in there: `gemdex_sparkle_start()` lazily creates and
// retains an `SPUStandardUpdaterController`, which installs the standard
// "Check for Updates…" menu wiring and begins Sparkle's automatic background
// checks. The feed URL and EdDSA public key live in Info.plist
// (SUFeedURL / SUPublicEDKey), injected by macos/embed-sparkle.sh at package
// time, so this code carries no configuration of its own.
//
// Idempotent: safe to call more than once. Must be called on the main thread
// (Sparkle creates UI), which the zero-native START event guarantees.

#import <Foundation/Foundation.h>
#import <Sparkle/Sparkle.h>

// Retained for the lifetime of the process. SPUStandardUpdaterController owns
// the SPUUpdater and its scheduled-check driver; dropping it would stop checks.
static SPUStandardUpdaterController *gGemdexUpdaterController = nil;

void gemdex_sparkle_start(void) {
    if (gGemdexUpdaterController != nil) {
        return;
    }
    if (![NSThread isMainThread]) {
        // Sparkle requires main-thread init. Bounce synchronously rather than
        // silently creating UI off-thread.
        dispatch_sync(dispatch_get_main_queue(), ^{
            gemdex_sparkle_start();
        });
        return;
    }

    // startingUpdater:YES kicks off the updater (and automatic checks when
    // SUEnableAutomaticChecks is set in Info.plist). No custom delegate: the
    // defaults (feed URL + public key from Info.plist) are all we need.
    gGemdexUpdaterController =
        [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                       updaterDelegate:nil
                                                    userDriverDelegate:nil];
}
