# Homebrew Cask for the Smriti desktop app.
#
# Lives here so it is versioned alongside the code that produces it; the
# release step copies it to jadonharsh109/homebrew-tap as Casks/smriti.rb.
#
#   brew install --cask jadonharsh109/tap/smriti   # desktop app  (this file)
#   brew install jadonharsh109/tap/smriti          # CLI/server   (Formula/smriti.rb)
#
# Sharing the "smriti" token with the formula is intentional and supported:
# Homebrew resolves by the --cask / --formula flag, and defaults to the formula
# (printing a hint about --cask) when neither is given.
cask "smriti" do
  version "0.1.27"
  sha256 "48eb3250a7c6168325a2a9424b2ccb788eec8118a71909220b3e654e61016a53"

  url "https://github.com/jadonharsh109/smriti.photos/releases/download/v#{version}/Smriti-#{version}-aarch64.zip"
  name "Smriti"
  desc "Fully-offline photo library for your local photos"
  homepage "https://github.com/jadonharsh109/smriti.photos"

  livecheck do
    url :url
    strategy :github_latest
  end

  # onnxruntime publishes no macOS x86_64 wheel, and its wheel tag is
  # macosx_14_0 — without these two lines Intel and pre-Sonoma users would
  # install an app that cannot start.
  depends_on arch: :arm64
  depends_on macos: :sonoma # symbol form = "this version or newer"; the
  #                           ">= :sonoma" string form is deprecated

  # The app has a built-in updater, so its on-disk version drifts ahead of what
  # the cask declares. Without this, `brew upgrade` would keep "downgrading"
  # it back to the cask's version and fight the self-updater.
  auto_updates true

  app "Smriti.app"

  postflight do
    # The app is ad-hoc signed but not notarized (no Apple Developer ID yet).
    # Homebrew quarantines every cask download, macOS 15+ removed the
    # right-click->Open bypass, and Homebrew removed --no-quarantine — so
    # without this, every user lands in System Settings -> Privacy & Security
    # to click "Open Anyway". Remove this stanza once builds are notarized.
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Smriti.app"]
  end

  caveats <<~EOS
    Smriti runs entirely on this Mac — no cloud, no account, nothing uploaded.

    Your library index lives in ~/Library/Application Support/Smriti, or in
    ~/.smriti if you already used the `smriti` command-line version (the app
    adopts that library in place, so both see the same photos).

    Do not run the app and `brew services start smriti` at the same time —
    they would both write the same database.

    People/face grouping needs a one-time ~280 MB model download, offered
    inside the app under Library setup.
  EOS

  zap trash: [
    "~/Library/Application Support/Smriti",
    "~/Library/Caches/photos.smriti.desktop",
    "~/Library/WebKit/photos.smriti.desktop",
    "~/Library/Saved Application State/photos.smriti.desktop.savedState",
    # shared with the CLI formula — this removes the entire photo index,
    # thumbnail cache and downloaded face models (originals are untouched)
    "~/.smriti",
  ]
end
