#!/bin/bash
# Builds, signs and uploads the iPhone app to App Store Connect (CI: .forgejo/workflows/release.yml).
#   ios/release.sh <version> <build number> [--no-upload]   (--no-upload stops after the export: build/export/Quilcast.ipa)
# No signing identity needed: archive unsigned, sign ad hoc with the app's identity, and App Store Connect signs it for
# distribution during the export (cloud signing with the API key in $API_PRIVATE_KEYS_DIR, default ~/.appstoreconnect/private_keys).
set -eo pipefail
cd "$(dirname "$0")"
TEAM=ACWP4F58HZ
KEY=${ASC_KEY_ID:-3FT23S9NSM}
ISSUER=${ASC_ISSUER_ID:-a18f42ff-6c44-410c-badf-50b11de8dbb8}
P8=${API_PRIVATE_KEYS_DIR:-~/.appstoreconnect/private_keys}/AuthKey_$KEY.p8
rm -rf build/Quilcast.xcarchive build/export build/sign.entitlements
xcodebuild -project Quilcast.xcodeproj -scheme Quilcast -destination 'generic/platform=iOS' -archivePath build/Quilcast.xcarchive \
  MARKETING_VERSION="$1" CURRENT_PROJECT_VERSION="$2" CODE_SIGNING_ALLOWED=NO archive | grep -E 'error:|ARCHIVE'
cp Quilcast.entitlements build/sign.entitlements
/usr/libexec/PlistBuddy -c "Add :application-identifier string $TEAM.com.borodutch.quilcast" \
  -c "Add :com.apple.developer.team-identifier string $TEAM" build/sign.entitlements > /dev/null
codesign -f -s - --entitlements build/sign.entitlements build/Quilcast.xcarchive/Products/Applications/Quilcast.app
xcodebuild -exportArchive -archivePath build/Quilcast.xcarchive -exportPath build/export -exportOptionsPlist ExportOptions.plist \
  -allowProvisioningUpdates -authenticationKeyPath $P8 -authenticationKeyID $KEY -authenticationKeyIssuerID $ISSUER | grep -E 'error:|EXPORT'
[ "$3" = --no-upload ] && exit
xcrun altool --upload-app -f build/export/Quilcast.ipa -t ios --apiKey $KEY --apiIssuer $ISSUER --p8-file-path $P8
