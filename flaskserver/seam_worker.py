#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import io
import os
import sqlite3
import time
import zlib
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from colored_log import get_logger
from seam_queue import (
    claim_next_job,
    enqueue_tile_and_neighbors,
    finish_job,
    init_seam_jobs,
    parse_tile_id,
)
from terrain_config import ENHANCE_DEPTH
from texture import build_water_mask, init_textures, write_texture, write_water_mask

log = get_logger("terrain.seam")

ENABLE_WATER_MASKS = os.environ.get("ENABLE_WATER_MASKS", "").strip().lower() in {"1", "true", "yes", "on"}

ENHANCED_SOURCES = {"dataforsyningen_enhanced", "sentinel2_enhanced", "upscaled"}
TARGET_DEPTH = ENHANCE_DEPTH
EDGE_BAND_MAX_FRACTION = 0.25
EDGE_BAND_MIN_FRACTION = 0.12
HIGH_FREQ_BLEND = 0.60
JITTER_FRACTION_OF_BAND = 0.32
CORNER_FADE_FRACTION = 0.20
JPEG_QUALITY = 90


def _default_db_path() -> Path:
    explicit = os.environ.get("TERRAIN_DB_PATH", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return Path(__file__).resolve().parent / "terrain.db"


def _load_tile_texture(db: sqlite3.Connection, tile_id: str) -> dict[str, Any] | None:
    row = db.execute(
        """
        SELECT t.depth, t.col, t.row, tx.source, tx.texture,
               t.x_min, t.y_min, t.x_max, t.y_max, t.heightmap
        FROM tiles t
        LEFT JOIN textures tx ON tx.tile_id = t.tile_id
        WHERE t.tile_id = ?
        """,
        (tile_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "tile_id": tile_id,
        "depth": int(row[0]),
        "col": int(row[1]),
        "row": int(row[2]),
        "source": row[3],
        "texture": row[4],
        "bbox": (float(row[5]), float(row[6]), float(row[7]), float(row[8])),
        "heightmap_blob": row[9],
    }


def _update_water_mask_for_tile(db: sqlite3.Connection, rec: dict[str, Any], jpeg: bytes) -> None:
    if not ENABLE_WATER_MASKS:
        return
    hm_blob = rec.get("heightmap_blob")
    if hm_blob is None:
        return
    try:
        hm = np.frombuffer(zlib.decompress(hm_blob), dtype=np.float32).reshape((65, 65))
    except Exception as exc:
        log.warning(f"[WATER MASK] {rec['tile_id']}: heightmap decode failed: {type(exc).__name__}: {exc}")
        return
    built = build_water_mask(jpeg, hm, rec["bbox"], resolution=256)
    if built is None:
        return
    mask_png, coverage = built
    write_water_mask(db, rec["tile_id"], mask_png, str(rec["source"]), coverage)


def _decode_jpeg(blob: bytes) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(blob)).convert("RGB"), dtype=np.uint8, copy=True)


def _encode_jpeg(arr: np.ndarray) -> bytes:
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def _gaussian_blur(arr: np.ndarray, radius: float = 1.8) -> np.ndarray:
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
    out = img.filter(ImageFilter.GaussianBlur(radius=radius))
    return np.asarray(out, dtype=np.float32)


def _tone_midpoint(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ma = a.mean(axis=(0, 1), keepdims=True)
    mb = b.mean(axis=(0, 1), keepdims=True)
    sa = a.std(axis=(0, 1), keepdims=True) + 1e-3
    sb = b.std(axis=(0, 1), keepdims=True) + 1e-3
    mm = (ma + mb) * 0.5
    sm = (sa + sb) * 0.5
    a_t = (a - ma) * (sm / sa) + mm
    b_t = (b - mb) * (sm / sb) + mm
    return a_t, b_t


def _smooth_2d(field: np.ndarray, radius: int) -> np.ndarray:
    """Fast separable box blur on a 2D float32 array."""
    rows, cols = field.shape
    if radius < 1 or rows < 3 or cols < 3:
        return field.copy()
    # Clamp kernel size to not exceed either dimension
    r_row = min(radius, (cols - 1) // 2)
    r_col = min(radius, (rows - 1) // 2)
    tmp = field.copy()
    if r_row >= 1:
        k = 2 * r_row + 1
        kernel = np.ones(k, dtype=np.float32) / float(k)
        for i in range(rows):
            tmp[i] = np.convolve(tmp[i], kernel, mode="same")
    out = tmp.copy()
    if r_col >= 1:
        k = 2 * r_col + 1
        kernel = np.ones(k, dtype=np.float32) / float(k)
        for j in range(cols):
            out[:, j] = np.convolve(tmp[:, j], kernel, mode="same")
    return out


def _alpha_field_2d(length: int, band: int, seed: int) -> np.ndarray:
    """Generate a 2D alpha field with organic noise for the blend boundary.

    Instead of per-row 1D offsets (which create visible banding on uniform
    surfaces like water), this builds a 2D noise field that warps the blend
    boundary into a smooth, natural-looking curve.
    """
    rng = np.random.default_rng(seed)

    # Base linear gradient: 0 at seam edge -> 1 at interior
    base_t = np.tile(
        np.linspace(0.0, 1.0, band, dtype=np.float32)[None, :],
        (length, 1),
    )

    # 2D noise to warp the blend boundary — amplitude is fraction of band width
    warp_amp = float(band) * JITTER_FRACTION_OF_BAND
    noise = rng.standard_normal((length, band)).astype(np.float32)
    # Smooth heavily so we get broad organic shapes, not pixel noise.
    # Radius scales with tile size so larger tiles get proportionally smooth warps.
    blur_r = max(4, min(length // 4, band // 2))
    noise = _smooth_2d(noise, blur_r)
    # Normalize to [-1, 1] range then scale
    nmax = np.abs(noise).max() or 1.0
    noise = noise / nmax * warp_amp

    # Warp the gradient: shift the "distance from edge" by noise
    warped = base_t * float(band) + noise
    t = np.clip(warped / max(1.0, float(band) - 1.0), 0.0, 1.0)

    # Smoothstep
    alpha = t * t * (3.0 - 2.0 * t)

    # Slight per-pixel power variation for organic feel (also 2D-smoothed)
    pow_noise = rng.uniform(0.85, 1.25, size=(length, band)).astype(np.float32)
    pow_noise = _smooth_2d(pow_noise, blur_r)
    alpha = np.power(alpha, pow_noise)

    return alpha


def _end_taper(length: int, fade_fraction: float) -> np.ndarray:
    """Return 0..1 weights that fade blending out at both seam ends (tile corners)."""
    if length <= 2:
        return np.ones(length, dtype=np.float32)
    fade = int(round(float(length) * float(fade_fraction)))
    fade = max(1, min(length // 2, fade))
    if fade <= 1:
        return np.ones(length, dtype=np.float32)
    t = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    # smoothstep ramp to avoid hard transitions
    ramp = t * t * (3.0 - 2.0 * t)
    out = np.ones(length, dtype=np.float32)
    out[:fade] = ramp
    out[-fade:] = ramp[::-1]
    return out


def _deep_blend(a: np.ndarray, b: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    # Tone-harmonize before low-frequency blend to avoid visible value jumps.
    a_t, b_t = _tone_midpoint(a, b)

    low_a = _gaussian_blur(a_t)
    low_b = _gaussian_blur(b_t)

    # Keep detail from original strips; mix it less aggressively than low-freq.
    high_a = a.astype(np.float32) - low_a
    high_b = b.astype(np.float32) - low_b

    a3 = alpha[..., None].astype(np.float32)
    low = (1.0 - a3) * low_a + a3 * low_b
    h3 = np.clip(a3 * HIGH_FREQ_BLEND, 0.0, 0.80)
    high = (1.0 - h3) * high_a + h3 * high_b
    return np.clip(low + high, 0.0, 255.0).astype(np.uint8)


def _blend_oriented(a_oriented: np.ndarray, b_oriented: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    length, band, _ = a_oriented.shape
    taper = _end_taper(length, CORNER_FADE_FRACTION)[:, None]

    # Asymmetric: each side gets its OWN noise field with DIFFERENT seeds,
    # and alpha is capped at 0.5 so the seam edge is a 50/50 mix — never
    # a full pixel swap (which is what causes the mirror artifact).
    alpha_a = np.clip(_alpha_field_2d(length, band, seed) * 0.5, 0.0, 0.5)
    alpha_b = np.clip(_alpha_field_2d(length, band, seed ^ 0x7E3C19A5) * 0.5, 0.0, 0.5)
    alpha_a *= taper
    alpha_b *= taper

    a_new = _deep_blend(a_oriented.astype(np.float32), b_oriented.astype(np.float32), alpha_a)
    b_new = _deep_blend(b_oriented.astype(np.float32), a_oriented.astype(np.float32), alpha_b)
    return a_new, b_new


def _blend_edge_pair(a: np.ndarray, b: np.ndarray, edge: str, seed: int, band: int) -> tuple[bool, bool]:
    changed_a = False
    changed_b = False

    if edge == "E":
        a_old = a[:, -band:, :].copy()
        b_old = b[:, :band, :].copy()
        a_or = a_old
        b_or = b_old[:, ::-1, :]
        a_new, b_new_or = _blend_oriented(a_or, b_or, seed)
        b_new = b_new_or[:, ::-1, :]
        a[:, -band:, :] = a_new
        b[:, :band, :] = b_new
        changed_a = bool(np.any(a_new != a_old))
        changed_b = bool(np.any(b_new != b_old))
    elif edge == "W":
        a_old = a[:, :band, :].copy()
        b_old = b[:, -band:, :].copy()
        a_or = a_old[:, ::-1, :]
        b_or = b_old
        a_new_or, b_new = _blend_oriented(a_or, b_or, seed)
        a_new = a_new_or[:, ::-1, :]
        a[:, :band, :] = a_new
        b[:, -band:, :] = b_new
        changed_a = bool(np.any(a_new != a_old))
        changed_b = bool(np.any(b_new != b_old))
    elif edge == "N":
        a_old = a[:band, :, :].copy()
        b_old = b[-band:, :, :].copy()
        a_or = np.transpose(a_old[::-1, :, :], (1, 0, 2))
        b_or = np.transpose(b_old, (1, 0, 2))
        a_new_or, b_new_or = _blend_oriented(a_or, b_or, seed)
        a_new = np.transpose(a_new_or, (1, 0, 2))[::-1, :, :]
        b_new = np.transpose(b_new_or, (1, 0, 2))
        a[:band, :, :] = a_new
        b[-band:, :, :] = b_new
        changed_a = bool(np.any(a_new != a_old))
        changed_b = bool(np.any(b_new != b_old))
    elif edge == "S":
        a_old = a[-band:, :, :].copy()
        b_old = b[:band, :, :].copy()
        a_or = np.transpose(a_old, (1, 0, 2))
        b_or = np.transpose(b_old[::-1, :, :], (1, 0, 2))
        a_new_or, b_new_or = _blend_oriented(a_or, b_or, seed)
        a_new = np.transpose(a_new_or, (1, 0, 2))
        b_new = np.transpose(b_new_or, (1, 0, 2))[::-1, :, :]
        a[-band:, :, :] = a_new
        b[:band, :, :] = b_new
        changed_a = bool(np.any(a_new != a_old))
        changed_b = bool(np.any(b_new != b_old))
    else:
        raise ValueError(f"Unknown edge: {edge}")

    return changed_a, changed_b


def _pair_seed(tile_id: str, neighbor_id: str, edge: str) -> int:
    a, b = sorted((tile_id, neighbor_id))
    # Canonicalize axis so seam gets same noise field regardless of which tile side
    # is currently processing it (E vs W, N vs S).
    axis = "EW" if edge in ("E", "W") else "NS"
    key = f"{a}|{b}|{axis}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def _is_blend_eligible(
    rec: dict[str, Any] | None,
) -> bool:
    return rec is not None and rec.get("texture") is not None and rec.get("source") in ENHANCED_SOURCES


def _process_tile(db: sqlite3.Connection, tile_id: str) -> str:
    rec = _load_tile_texture(db, tile_id)
    if rec is None:
        return "missing_tile"
    if not _is_blend_eligible(rec):
        return f"skip_not_enhanced source={rec['source']!r}"

    parsed = parse_tile_id(tile_id)
    if parsed is None:
        return "bad_tile_id"
    depth, col, row = parsed
    if depth != TARGET_DEPTH:
        return "skip_wrong_depth"
    n = 1 << depth

    self_img = _decode_jpeg(rec["texture"])
    h, w = self_img.shape[:2]
    tile_px = min(h, w)
    band_max = int(round(float(tile_px) * EDGE_BAND_MAX_FRACTION))
    band_min = int(round(float(tile_px) * EDGE_BAND_MIN_FRACTION))
    band = max(8, min(band_max, max(band_min, tile_px // 2)))
    if band < 8:
        return "skip_too_small"

    edges = (
        ("E", col + 1, row),
        ("W", col - 1, row),
        ("N", col, row + 1),
        ("S", col, row - 1),
    )

    changed_self = False
    neighbor_writes = 0
    eligible_neighbors: list[str] = []
    shape_mismatch_neighbors: list[str] = []
    considered_neighbors = 0

    for edge, nc, nr in edges:
        if nc < 0 or nr < 0 or nc >= n or nr >= n:
            continue
        nid = f"{depth}-{nc}-{nr}"
        considered_neighbors += 1
        nrec = _load_tile_texture(db, nid)
        if nrec is None:
            continue
        if not _is_blend_eligible(nrec):
            continue
        eligible_neighbors.append(nid)

        neighbor_img = _decode_jpeg(nrec["texture"])
        if neighbor_img.shape != self_img.shape:
            shape_mismatch_neighbors.append(nid)
            continue

        seed = _pair_seed(tile_id, nid, edge)
        c_self, c_neighbor = _blend_edge_pair(self_img, neighbor_img, edge=edge, seed=seed, band=band)
        changed_self = changed_self or c_self
        if c_neighbor:
            out_jpeg = _encode_jpeg(neighbor_img)
            write_texture(db, nid, out_jpeg, nrec["source"])
            _update_water_mask_for_tile(db, nrec, out_jpeg)
            neighbor_writes += 1

    if changed_self:
        out_jpeg = _encode_jpeg(self_img)
        write_texture(db, tile_id, out_jpeg, rec["source"])
        _update_water_mask_for_tile(db, rec, out_jpeg)

    if changed_self or neighbor_writes:
        return (
            f"blended self={int(changed_self)} neighbors={neighbor_writes} "
            f"eligible_neighbors={len(eligible_neighbors)}/{considered_neighbors}"
        )

    if not eligible_neighbors:
        return f"no_changes eligible_neighbors=0/{considered_neighbors}"

    preview = ",".join(eligible_neighbors[:3])
    more = len(eligible_neighbors) - min(3, len(eligible_neighbors))
    suffix = f",+{more}" if more > 0 else ""
    mismatch_note = (
        f" shape_mismatch={len(shape_mismatch_neighbors)}"
        if shape_mismatch_neighbors
        else ""
    )
    return (
        f"no_changes eligible_neighbors={len(eligible_neighbors)}/{considered_neighbors} "
        f"against=[{preview}{suffix}]{mismatch_note}"
    )


def _corner_radial_mask(size: int) -> np.ndarray:
    """Radial falloff mask for a square corner patch: 0 at corner, 1 at far edge."""
    y = np.linspace(0.0, 1.0, size, dtype=np.float32)
    x = np.linspace(0.0, 1.0, size, dtype=np.float32)
    yy, xx = np.meshgrid(y, x, indexing="ij")
    dist = np.sqrt(xx * xx + yy * yy)
    dist = np.clip(dist / 1.414, 0.0, 1.0)  # normalize by diagonal
    return dist * dist * (3.0 - 2.0 * dist)  # smoothstep


def _restore_corners(
    blended: np.ndarray,
    original: np.ndarray,
    blended_edges: set[str],
    band: int,
) -> None:
    """Where two adjacent blended edges meet at a corner, fade back to original
    to prevent symmetric double-blend artifacts."""
    h, w = blended.shape[:2]
    patch = max(8, band // 2)
    mask = _corner_radial_mask(patch)

    # Each corner is defined by two adjacent edges and its pixel region.
    # mask is 0 at the actual corner (= use original) and 1 at the far diagonal (= keep blend).
    corners = [
        ("N", "E", slice(0, patch), slice(w - patch, w), np.flip(mask, axis=1)),
        ("N", "W", slice(0, patch), slice(0, patch), mask),
        ("S", "E", slice(h - patch, h), slice(w - patch, w), np.flip(np.flip(mask, axis=0), axis=1)),
        ("S", "W", slice(h - patch, h), slice(0, patch), np.flip(mask, axis=0)),
    ]

    for e1, e2, rs, cs, m in corners:
        if e1 in blended_edges and e2 in blended_edges:
            m3 = m[..., None]
            blended[rs, cs, :] = np.clip(
                m3 * blended[rs, cs, :].astype(np.float32)
                + (1.0 - m3) * original[rs, cs, :].astype(np.float32),
                0.0, 255.0,
            ).astype(np.uint8)


def preblend_for_enhance(db: sqlite3.Connection, tile_id: str, texture_jpeg: bytes) -> bytes:
    """Blend a tile's edges toward any enhanced neighbors before sending to ComfyUI.

    Only modifies the tile being enhanced (one-sided blend). Returns the
    modified JPEG bytes, or the original if no enhanced neighbors exist.
    """
    parsed = parse_tile_id(tile_id)
    if parsed is None:
        return texture_jpeg
    depth, col, row = parsed
    if depth != TARGET_DEPTH:
        return texture_jpeg
    n = 1 << depth

    self_img = _decode_jpeg(texture_jpeg)
    h, w = self_img.shape[:2]
    tile_px = min(h, w)
    band_max = int(round(float(tile_px) * EDGE_BAND_MAX_FRACTION))
    band_min = int(round(float(tile_px) * EDGE_BAND_MIN_FRACTION))
    band = max(8, min(band_max, max(band_min, tile_px // 2)))
    if band < 8:
        return texture_jpeg

    edges = (
        ("E", col + 1, row),
        ("W", col - 1, row),
        ("N", col, row + 1),
        ("S", col, row - 1),
    )

    original = self_img.copy()
    changed = False
    blended_edges = set()
    for edge, nc, nr in edges:
        if nc < 0 or nr < 0 or nc >= n or nr >= n:
            continue
        nid = f"{depth}-{nc}-{nr}"
        nrec = _load_tile_texture(db, nid)
        if nrec is None:
            continue
        if not _is_blend_eligible(nrec):
            continue
        neighbor_img = _decode_jpeg(nrec["texture"])
        if neighbor_img.shape != self_img.shape:
            continue

        seed = _pair_seed(tile_id, nid, edge)
        c_self, _ = _blend_edge_pair(self_img, neighbor_img, edge=edge, seed=seed, band=band)
        if c_self:
            changed = True
            blended_edges.add(edge)

    if changed:
        # Restore corners where two adjacent edges were both blended to
        # avoid symmetric double-blend artifacts.
        _restore_corners(self_img, original, blended_edges, band)
        log.info(f"[PREBLEND] {tile_id}: blended edges {','.join(sorted(blended_edges))} toward enhanced neighbors")
        return _encode_jpeg(self_img)
    return texture_jpeg


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Process seam_jobs queue and blend seams between enhanced neighbor tiles."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=_default_db_path(),
        help="Path to terrain.db (default: TERRAIN_DB_PATH or flaskserver/terrain.db)",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=1.5,
        help="Sleep interval when queue is empty.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run until queue is empty, then exit.",
    )
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=0,
        help="Process at most N jobs then exit (0 = unlimited).",
    )
    parser.add_argument(
        "--enqueue-existing",
        action="store_true",
        help="Queue seam jobs for all currently enhanced/upscaled textures before processing.",
    )
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    db_path = args.db.expanduser().resolve()
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    db = sqlite3.connect(str(db_path), check_same_thread=False)
    db.execute("PRAGMA journal_mode=WAL")
    init_textures(db)
    init_seam_jobs(db)

    if args.enqueue_existing:
        rows = db.execute(
            """
            SELECT tx.tile_id
            FROM textures tx
            JOIN tiles t ON t.tile_id = tx.tile_id
            WHERE tx.source IN ('dataforsyningen_enhanced', 'sentinel2_enhanced', 'upscaled')
              AND t.depth = ?
            """,
            (TARGET_DEPTH,),
        ).fetchall()
        for row in rows:
            enqueue_tile_and_neighbors(
                db,
                str(row[0]),
                center_priority=100,
                neighbor_priority=60,
            )
        log.info(f"[SEAM] enqueued existing enhanced tiles: {len(rows)}")

    processed = 0
    log.info(f"[SEAM] worker started. db={db_path}")
    try:
        while True:
            tile_id = claim_next_job(db)
            if tile_id is None:
                if args.once:
                    break
                time.sleep(max(0.1, args.poll_seconds))
                continue

            try:
                msg = _process_tile(db, tile_id)
                finish_job(db, tile_id, ok=True)
                log.info(f"[SEAM] {tile_id}: {msg}")
            except Exception as exc:
                finish_job(db, tile_id, ok=False, error=f"{type(exc).__name__}: {exc}")
                log.error(f"[SEAM] {tile_id}: FAILED {type(exc).__name__}: {exc}")

            processed += 1
            if args.max_jobs > 0 and processed >= args.max_jobs:
                break
    finally:
        db.close()

    log.info(f"[SEAM] worker exiting. processed={processed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
