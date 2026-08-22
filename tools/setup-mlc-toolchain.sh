#!/bin/bash
# Stand up the MLC/TVM toolchain needed to compile a WebGPU model library on
# macOS arm64. Idempotent. Run from the repo root.
#
# Nothing here is optional polish — each step works around something that is
# actually broken in the published nightlies:
#
#   * The wheels' dylibs carry ad-hoc signatures that do not match their bytes,
#     so macOS SIGKILLs the process at dlopen (CODESIGNING / Invalid Page).
#   * `apache-tvm-ffi` must be pinned to 0.1.13; 0.1.13.post3 is ABI-incompatible
#     with the bundled runtime and corrupts the heap in a static initializer.
#   * `psutil` is imported by `mlc_llm.serve` but missing from the wheel metadata.
#   * Two source-level version-skew bugs (see tools/patch-mlc-nightly.py).
#   * `--device webgpu` needs `web/dist/wasm/*.bc`, which the wheels neither ship
#     nor can build: their pruned header tree is internally inconsistent. Those
#     are built from an apache/tvm checkout pinned to the wheel's own commit.
#
set -euo pipefail

VENV="${VENV:-.venv-mlc}"
SP="$PWD/$VENV/lib/python3.12/site-packages"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/mlc-web-build}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"

echo "==> python packages"
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --pre -U -f https://mlc.ai/wheels mlc-llm-nightly-cpu mlc-ai-nightly-cpu
# Pin: >=0.1.13 resolves to a .post release whose ABI does not match the wheels.
"$VENV/bin/pip" install -q "apache-tvm-ffi==0.1.13" psutil

echo "==> re-signing wheel dylibs"
sh tools/resign-venv.sh "$SP" >/dev/null

echo "==> patching mlc_llm sources"
"$VENV/bin/python" tools/patch-mlc-nightly.py "$SP"

echo "==> emscripten"
if [ ! -d "$EMSDK_DIR/.git" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
(cd "$EMSDK_DIR" && ./emsdk install latest >/dev/null && ./emsdk activate latest >/dev/null)
# shellcheck disable=SC1091
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1

echo "==> tvm web runtime (from source, at the wheel's own commit)"
# The wheel records the commit it was built from; the runtime linked into the
# .wasm must come from that same commit as the codegen that produced the kernels.
COMMIT=$("$VENV/bin/python" -c "import tvm._version as v; print(v.__commit_id__.lstrip('g'))")
mkdir -p "$BUILD_DIR"
if [ ! -d "$BUILD_DIR/tvm/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/apache/tvm.git "$BUILD_DIR/tvm"
fi
cd "$BUILD_DIR/tvm"
if [ "$(git rev-parse --short HEAD 2>/dev/null)" != "$COMMIT" ]; then
  FULL=$(curl -fsSL "https://api.github.com/repos/apache/tvm/commits/$COMMIT" \
         | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
  git fetch --filter=blob:none origin "$FULL"
  git checkout -q "$FULL"
fi
git submodule update --init --recursive --depth 1 3rdparty/tvm-ffi >/dev/null

# tvm's web runtime pulls in tvm-ffi's sources one by one and misses
# custom_allocator.cc, so TVMFFIGetCustomAllocator is left undefined and becomes
# a wasm *import*. No published @mlc-ai/web-llm (0.2.84 is latest) supplies it,
# and the model then fails to instantiate with
#   LinkError: import object field 'TVMFFIGetCustomAllocator' is not a Function
# Compiling it in makes the import list identical to a known-good MLC build.
python3 - <<'PATCH'
from pathlib import Path
p = Path("web/emcc/wasm_runtime.cc")
s = p.read_text()
inc = '#include "3rdparty/tvm-ffi/src/ffi/custom_allocator.cc"\n'
anchor = '#include "3rdparty/tvm-ffi/src/ffi/container.cc"\n'
if inc not in s:
    assert anchor in s, "wasm_runtime.cc include block changed shape"
    p.write_text(s.replace(anchor, anchor + inc, 1))
    print("  added custom_allocator.cc")
PATCH

TVM_HOME="$BUILD_DIR/tvm" make -C web \
  dist/wasm/wasm_runtime.bc dist/wasm/tvmjs_support.bc dist/wasm/webgpu_runtime.bc >/dev/null
cd - >/dev/null

echo "==> mlc wasm runtime stub"
# In this version mlc_wasm_runtime.cc is only #defines — its actual runtime moved
# into tvm's wasm_runtime.cc — so it compiles with no include path at all.
mkdir -p "$SP/mlc_llm/web/dist/wasm"
emcc -O3 -std=c++17 -Wno-ignored-attributes -emit-llvm \
  -c -o "$SP/mlc_llm/web/dist/wasm/mlc_wasm_runtime.bc" \
  "$SP/mlc_llm/web/emcc/mlc_wasm_runtime.cc"

echo
echo "ready. to compile, first:"
echo "  . $EMSDK_DIR/emsdk_env.sh"
echo "  export TVM_HOME=$BUILD_DIR/tvm"
echo "  export MLC_LLM_SOURCE_DIR=$SP/mlc_llm"
