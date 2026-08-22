#!/bin/sh
# The MLC nightly wheels ship dylibs whose ad-hoc signatures do not match their
# bytes, so macOS SIGKILLs the process at dlopen with CODESIGNING/Invalid Page.
# Re-signing ad-hoc recomputes the hashes over the real content. Re-run after
# any pip install that touches these packages.
SP="${1:-.venv-mlc/lib/python3.12/site-packages}"
find "$SP" \( -name "*.dylib" -o -name "*.so" \) -print | while read -r f; do
  codesign -v "$f" 2>/dev/null || codesign --force --sign - "$f" >/dev/null 2>&1
done
echo "re-signed; remaining failures:"
find "$SP" \( -name "*.dylib" -o -name "*.so" \) -print | while read -r f; do
  codesign -v "$f" 2>/dev/null || echo "  $f"
done
