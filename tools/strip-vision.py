#!/usr/bin/env python3
"""Keep only the text path of Qwen3.8-2B-Distill: drop `model.visual.*` and `mtp.*`.

Streams byte ranges straight from the source safetensors rather than loading it,
so it runs in a few MB of RAM instead of the 4.5 GB the tensors occupy — this
machine has 16 GB and the compile that follows wants most of it.

Also flattens the nested `text_config` into a top-level config, because the
checkpoint is a `Qwen3_5ForConditionalGeneration` (vision-language) while what
comes out is a plain causal LM.

    python3 tools/strip-vision.py [--src DIR] [--dst DIR] [--keep-prefix]
"""

import argparse
import json
import shutil
import struct
from pathlib import Path

KEEP_PREFIX = "model.language_model."
# Copied verbatim beside the weights; the vision/video preprocessors are not.
SIDE_FILES = [
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "generation_config.json",
    "chat_template.jinja",
]
COPY_CHUNK = 32 << 20


def read_header(path: Path):
    with path.open("rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(n))
    return header, 8 + n


def strip_weights(src: Path, dst: Path, rename: bool) -> dict:
    header, data_start = read_header(src)
    header.pop("__metadata__", None)

    keep = {k: v for k, v in header.items() if k.startswith(KEEP_PREFIX)}
    if not keep:
        raise SystemExit(f"no tensors under {KEEP_PREFIX!r} in {src}")

    # Preserve source order so the reads stay sequential across the 4.5 GB file.
    ordered = sorted(keep.items(), key=lambda kv: kv[1]["data_offsets"][0])

    out_header, cursor = {}, 0
    for name, spec in ordered:
        begin, end = spec["data_offsets"]
        out_name = ("model." + name[len(KEEP_PREFIX) :]) if rename else name
        out_header[out_name] = {
            "dtype": spec["dtype"],
            "shape": spec["shape"],
            "data_offsets": [cursor, cursor + (end - begin)],
        }
        cursor += end - begin

    out_header["__metadata__"] = {"format": "pt"}
    blob = json.dumps(out_header, separators=(",", ":")).encode("utf-8")
    # safetensors requires the data section to start 8-byte aligned.
    blob += b" " * (-len(blob) % 8)

    dst.parent.mkdir(parents=True, exist_ok=True)
    with src.open("rb") as fin, dst.open("wb") as fout:
        fout.write(struct.pack("<Q", len(blob)))
        fout.write(blob)
        for name, spec in ordered:
            begin, end = spec["data_offsets"]
            fin.seek(data_start + begin)
            remaining = end - begin
            while remaining:
                chunk = fin.read(min(COPY_CHUNK, remaining))
                if not chunk:
                    raise SystemExit(f"truncated source while reading {name}")
                fout.write(chunk)
                remaining -= len(chunk)

    dropped = len(header) - len(keep)
    return {"kept": len(keep), "dropped": dropped, "bytes": cursor}


def flatten_config(src: Path, dst: Path) -> dict:
    cfg = json.loads((src / "config.json").read_text())
    text = dict(cfg.get("text_config") or {})
    if not text:
        raise SystemExit("config.json has no text_config to flatten")

    text["architectures"] = ["Qwen3_5ForCausalLM"]
    text["model_type"] = cfg.get("model_type", "qwen3_5")
    text.setdefault("tie_word_embeddings", cfg.get("tie_word_embeddings", True))
    text["transformers_version"] = cfg.get("transformers_version", "")
    # Both stop tokens: generation_config carries the pair, config.json only one.
    gen = json.loads((src / "generation_config.json").read_text())
    eos = gen.get("eos_token_id", text.get("eos_token_id"))
    text["eos_token_id"] = eos if isinstance(eos, list) else [eos]
    # The MTP head is dropped, so nothing should advertise it.
    for k in ("mtp_num_hidden_layers", "mtp_use_dedicated_embeddings"):
        text.pop(k, None)
    # MLC's Qwen3_5Config reads `rope_theta` and `partial_rotary_factor` at the top
    # level (confirmed against the verified 0.8B's emitted `model_config`), while
    # this checkpoint nests them under transformers' newer `rope_parameters`. Left
    # nested they would silently fall back to MLC's defaults.
    rope = text.pop("rope_parameters", None) or {}
    for k in ("rope_theta", "partial_rotary_factor"):
        if k in rope:
            text[k] = rope[k]
    if "rope_theta" not in text:
        raise SystemExit("no rope_theta found in config")

    (dst / "config.json").write_text(json.dumps(text, indent=2) + "\n")
    return text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="model/Qwen3.8-2B-Distill", type=Path)
    ap.add_argument("--dst", default="model/Qwen3.8-2B-text", type=Path)
    ap.add_argument(
        "--keep-prefix",
        action="store_true",
        help="keep names as `model.language_model.*` instead of rewriting to `model.*`",
    )
    args = ap.parse_args()

    args.dst.mkdir(parents=True, exist_ok=True)
    stats = strip_weights(
        args.src / "model.safetensors", args.dst / "model.safetensors", rename=not args.keep_prefix
    )
    cfg = flatten_config(args.src, args.dst)
    for name in SIDE_FILES:
        if (args.src / name).exists():
            shutil.copy2(args.src / name, args.dst / name)

    print(
        f"{stats['kept'] + stats['dropped']} -> {stats['kept']} tensors, "
        f"{stats['bytes'] / 1e9:.2f} GB written"
    )
    print(
        f"config: hidden_size={cfg['hidden_size']} intermediate_size={cfg['intermediate_size']} "
        f"layers={cfg['num_hidden_layers']} eos={cfg['eos_token_id']}"
    )


if __name__ == "__main__":
    main()
