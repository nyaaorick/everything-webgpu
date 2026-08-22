#!/usr/bin/env python3
"""Reconcile `mlc-llm-nightly-cpu 0.26.dev6` with `mlc-ai-nightly-cpu 0.26.dev246`.

Idempotent; re-run after any pip install that touches these packages.

The published nightlies do not pair. mlc-llm 0.26.dev6 is written against an
unreleased TVM in which `PrimFunc.params` holds `Buffer`s directly; every
published mlc-ai wheel (dev61/dev203/dev246) still has `params: Array<Var>` plus
a separate `buffer_map`, and none of them defines the `tirx.is_buffer_var` that
dev6 calls. Going the other way is no better: mlc-llm 0.20.dev162's Python does
use `buffer_map`, but its dylib wants TVM symbols (`TVMBackendParallelLaunch`)
that dev246 no longer exports.

So dev6 is kept — it has the newest `qwen3_5` model definition and the correct
`qwen3_5` conversation template — and the handful of places where it reaches for
the unreleased API are rewritten against `buffer_map`. Those rewrites are not
invented: each restores what mlc-llm 0.20.dev162 does in the same function, kept
on dev6's relax spelling (`TensorType`/`ty_args`, where dev162 said
`TensorStructInfo`/`sinfo_args`). Verified against dev246:

    PrimFunc(params, body, ret_type=None, buffer_map=None, attrs=None, span=None)
    Var has no `.dtype`      -> membership in `buffer_map` is the buffer test
    relax.TensorType/ty_args -> present; TensorStructInfo/sinfo_args are not

Also fixed here:
  * `nn/rnn_state.py` binds the recurrent-state gather/scatter indices to
    annotated locals (`seq_id: T.int32 = seq_slot_ids[vi]`). This TVM then infers
    a block read region whose bound names a buffer `seq_id` that is never
    declared, and rejects the function — from the C++ verifier, so silencing the
    parser's check only defers it. Inlining each load at its one use site is the
    same computation and verifies clean. Qwen3.5 is 75% GatedDeltaNet, so
    RNNState is on the critical path and cannot be skipped.
  * Every loader passes `mlc_param.dtype` into `numpy.astype`, but in this TVM
    that is a `tvm.ir.type.PrimType` (`T.float16`), not the `str` numpy needs.
  * TVM links the final `.wasm` with `emcc`, which under emscripten 6.x no longer
    pulls in the C++ stdlib for bitcode inputs.

Dylib signature repair lives in `tools/resign-venv.sh`.
"""

import sys
from pathlib import Path

# (relative path, find, replace)
PATCHES = [
    # --- RNN state: bind the gather/scatter indices inline ------------------
    # `seq_id: T.int32 = seq_slot_ids[vi]` inside an sblock makes this TVM infer
    # a read region whose bound refers to a buffer named `seq_id` that was never
    # declared, and the C++ verifier rejects the function. Substituting the load
    # at its single use site is the same computation and verifies clean.
    (
        "mlc_llm/nn/rnn_state.py",
        """                            seq_id: T.int32 = seq_slot_ids[vi]
                            history_id: T.int32 = history_slot_ids[vi]
                            output[vi, vs] = storage[seq_id, history_id, vs]""",
        """                            output[vi, vs] = storage[
                                seq_slot_ids[vi], history_slot_ids[vi], vs
                            ]""",
    ),
    (
        "mlc_llm/nn/rnn_state.py",
        """                            seq_id: T.int32 = seq_slot_ids[vi]
                            history_id: T.int32 = history_slot_ids[vi]
                            # The following line is equivalent to:
                            # `output[vi, *vs] = storage[seq_id, history_id, *vs]`
                            # However, unpacking operator in subscript requires Python 3.11 or newer
                            T.buffer_store(
                                output,
                                T.BufferLoad(storage, [seq_id, history_id, *vs]),
                                [vi, *vs],
                            )""",
        """                            # Equivalent to
                            # `output[vi, *vs] = storage[seq, history, *vs]`; the
                            # unpacking operator in a subscript needs Python 3.11+.
                            T.buffer_store(
                                output,
                                T.BufferLoad(
                                    storage,
                                    [seq_slot_ids[vi], history_slot_ids[vi], *vs],
                                ),
                                [vi, *vs],
                            )""",
    ),
    (
        "mlc_llm/nn/rnn_state.py",
        """                            seq_id: T.int32 = seq_slot_ids[vi]
                            history_id: T.int32 = (history_slot_ids[vi] + 1) % T.cast(
                                max_history, "int32"
                            )
                            storage[seq_id, history_id, vs] = data[vi, vs]""",
        """                            storage[
                                seq_slot_ids[vi],
                                (history_slot_ids[vi] + 1) % T.cast(max_history, "int32"),
                                vs,
                            ] = data[vi, vs]""",
    ),
    (
        "mlc_llm/nn/rnn_state.py",
        """                            seq_id: T.int32 = seq_slot_ids[vi]
                            history_id: T.int32 = (history_slot_ids[vi] + 1) % T.cast(
                                max_history, "int32"
                            )
                            # The following line is equivalent to:
                            # `storage[seq_id, history_id, *vs] = data[vi, *vs]`
                            # However, unpacking operator in subscript requires Python 3.11 or newer
                            T.buffer_store(
                                storage,
                                T.BufferLoad(data, [vi, *vs]),
                                [seq_id, history_id, *vs],
                            )""",
        """                            # Equivalent to
                            # `storage[seq, history, *vs] = data[vi, *vs]`; the
                            # unpacking operator in a subscript needs Python 3.11+.
                            T.buffer_store(
                                storage,
                                T.BufferLoad(data, [vi, *vs]),
                                [
                                    seq_slot_ids[vi],
                                    (history_slot_ids[vi] + 1) % T.cast(max_history, "int32"),
                                    *vs,
                                ],
                            )""",
    ),
    # --- numpy cannot consume a PrimType ------------------------------------
    (
        "mlc_llm/model/qwen35/qwen35_loader.py",
        "dtype=mlc_param.dtype",
        "dtype=str(mlc_param.dtype)",
    ),
    # --- is_buffer_var: the buffer params are exactly buffer_map's values ----
    (
        "mlc_llm/compiler_pass/low_batch_specialization.py",
        "buffers = [param for param in func.params if tirx.is_buffer_var(param)]",
        "buffers = func.buffer_map.values()",
    ),
    # --- link the wasm with em++, not emcc -----------------------------------
    # The runtime .bc objects are C++, but emscripten 6.x no longer infers that
    # from bitcode inputs, so wasm-ld fails on std::cerr and the ostringstream
    # vtables. em++ is emscripten's own suggested fix and links the C++ stdlib.
    (
        "tvm/support/emcc.py",
        'def create_tvmjs_wasm(output, objects, options=None, cc="emcc", libs=None):',
        'def create_tvmjs_wasm(output, objects, options=None, cc="em++", libs=None):',
    ),
    # --- lifting global TIR allocs: carry a buffer_map instead of Buffer params
    (
        "mlc_llm/compiler_pass/lift_global_buffer_alloc.py",
        """    params = list(func.params)
    tensor_sinfo = []
    alloc_buffers = []

    insertion_point = len(params)
    while not tirx.is_buffer_var(params[insertion_point - 1]):
        insertion_point -= 1
        assert insertion_point >= 1

    prev_root_block = func.body.block
    for buf_alloc in func.body.block.alloc_buffers:
        if buf_alloc.scope() == "global":
            params.insert(insertion_point, buf_alloc)
            insertion_point += 1
            tensor_sinfo.append(relax.TensorType(buf_alloc.shape, buf_alloc.dtype))""",
        """    params = list(func.params)
    buffer_map = dict(func.buffer_map)
    tensor_sinfo = []
    alloc_buffers = []

    insertion_point = len(params)
    while params[insertion_point - 1] not in func.buffer_map:
        insertion_point -= 1
        assert insertion_point >= 1

    prev_root_block = func.body.block
    for buf_alloc in func.body.block.alloc_buffers:
        if buf_alloc.scope() == "global":
            param = tirx.Var("var_" + buf_alloc.name, "handle")
            params.insert(insertion_point, param)
            insertion_point += 1
            buffer_map[param] = buf_alloc
            tensor_sinfo.append(relax.TensorType(buf_alloc.shape, buf_alloc.dtype))""",
    ),
    (
        "mlc_llm/compiler_pass/lift_global_buffer_alloc.py",
        """        ret_type=func.ret_type,
        attrs=func.attrs,
    )
    return updated_func, tensor_sinfo""",
        """        ret_type=func.ret_type,
        buffer_map=buffer_map,
        attrs=func.attrs,
    )
    return updated_func, tensor_sinfo""",
    ),
    (
        "mlc_llm/compiler_pass/lift_global_buffer_alloc.py",
        "        buffer_shape = func.params[i].shape",
        "        buffer_shape = func.buffer_map[func.params[i]].shape",
    ),
    (
        "mlc_llm/compiler_pass/lift_global_buffer_alloc.py",
        "        buffer_shape = func.params[n_arg + i].shape",
        "        buffer_shape = func.buffer_map[func.params[n_arg + i]].shape",
    ),
]


def main() -> int:
    site = Path(
        sys.argv[1] if len(sys.argv) > 1 else ".venv-mlc/lib/python3.12/site-packages"
    )
    failed = False
    for rel, old, new in PATCHES:
        target = site / rel
        label = f"{rel}: {old.strip().splitlines()[0][:52]}"
        if not target.exists():
            print(f"  MISSING  {rel}")
            failed = True
            continue
        text = target.read_text()
        if new in text:
            print(f"  ok       {label}")
            continue
        if old not in text:
            print(f"  NO MATCH {label}")
            failed = True
            continue
        target.write_text(text.replace(old, new))
        print(f"  patched  {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
