"""Deterministic procedural terrain super-resolution.

The measured DEM is bilinearly resampled and, when requested, a
world-coordinate procedural residual is added between measured samples. The
residual is constrained to zero at every source sample and along the tile
border, so processing a tile cannot invalidate repaired seams.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from time import perf_counter
import zipfile

import numpy as np
from PIL import Image

from colored_log import get_logger


DEFAULT_SEED = 0x41544C41  # "ATLA"
log_upscale = get_logger("terrain.upscale")

# Bump when the derived DEM/texture recipe changes shape.
# serve_flask compares this against the 'macro_terrain_version' metadata row
# on startup, resets every cooked_dem tile back to pending, and drops
# cooked_upscale textures, so exploration recooks both with the current
# recipe.
MACRO_TERRAIN_VERSION = 5

def _smoothstep(value):
    return value * value * (3.0 - 2.0 * value)


def _hash_noise(column, row, seed):
    """Return stable pseudo-random values in [-1, 1] for integer coordinates."""
    x = np.asarray(column, dtype=np.int64).astype(np.uint64)
    y = np.asarray(row, dtype=np.int64).astype(np.uint64)
    mask = np.uint64(0xFFFFFFFFFFFFFFFF)
    value = (
        x * np.uint64(0x9E3779B185EBCA87)
        + y * np.uint64(0xC2B2AE3D27D4EB4F)
        + np.uint64(seed & 0xFFFFFFFFFFFFFFFF)
    ) & mask
    value ^= value >> np.uint64(30)
    value = (value * np.uint64(0xBF58476D1CE4E5B9)) & mask
    value ^= value >> np.uint64(27)
    value = (value * np.uint64(0x94D049BB133111EB)) & mask
    value ^= value >> np.uint64(31)
    # Use the top 53 bits so conversion to float64 is defined and repeatable.
    unit = (value >> np.uint64(11)).astype(np.float64) / float(1 << 53)
    return unit * 2.0 - 1.0


def _value_noise(x, y, wavelength, seed):
    scaled_x = np.asarray(x, dtype=np.float64) / float(wavelength)
    scaled_y = np.asarray(y, dtype=np.float64) / float(wavelength)
    x0 = np.floor(scaled_x).astype(np.int64)
    y0 = np.floor(scaled_y).astype(np.int64)
    tx = _smoothstep(scaled_x - x0)
    ty = _smoothstep(scaled_y - y0)

    southwest = _hash_noise(x0, y0, seed)
    southeast = _hash_noise(x0 + 1, y0, seed)
    northwest = _hash_noise(x0, y0 + 1, seed)
    northeast = _hash_noise(x0 + 1, y0 + 1, seed)
    south = southwest + (southeast - southwest) * tx
    north = northwest + (northeast - northwest) * tx
    return south + (north - south) * ty


def _fbm(x, y, base_wavelength, octaves, seed, persistence=0.5):
    result = np.zeros(np.broadcast_shapes(np.shape(x), np.shape(y)), dtype=np.float64)
    amplitude = 1.0
    amplitude_sum = 0.0
    wavelength = float(base_wavelength)
    for octave in range(octaves):
        result += amplitude * _value_noise(
            x, y, wavelength, seed + octave * 0x9E3779B9,
        )
        amplitude_sum += amplitude
        amplitude *= persistence
        wavelength *= 0.5
    return result / amplitude_sum


def _resize_bilinear(values, output_rows, output_columns):
    """Bilinear resize for a numerical raster."""
    source = np.asarray(values, dtype=np.float64)
    source_rows, source_columns = source.shape
    rows = np.linspace(0.0, source_rows - 1, output_rows)
    columns = np.linspace(0.0, source_columns - 1, output_columns)
    r0 = np.floor(rows).astype(int)
    c0 = np.floor(columns).astype(int)
    r1 = np.minimum(r0 + 1, source_rows - 1)
    c1 = np.minimum(c0 + 1, source_columns - 1)
    rf = rows - r0
    cf = columns - c0
    return (
        source[np.ix_(r0, c0)] * (1.0 - rf[:, None]) * (1.0 - cf[None, :])
        + source[np.ix_(r0, c1)] * (1.0 - rf[:, None]) * cf[None, :]
        + source[np.ix_(r1, c0)] * rf[:, None] * (1.0 - cf[None, :])
        + source[np.ix_(r1, c1)] * rf[:, None] * cf[None, :]
    )


def _bilinear(values, output_resolution):
    """Bilinear resize a square numerical raster."""
    return _resize_bilinear(values, output_resolution, output_resolution)


def _nearest_mask(values, output_resolution):
    source = np.asarray(values, dtype=bool)
    row_indices = np.rint(
        np.linspace(0, source.shape[0] - 1, output_resolution)
    ).astype(int)
    column_indices = np.rint(
        np.linspace(0, source.shape[1] - 1, output_resolution)
    ).astype(int)
    return source[np.ix_(row_indices, column_indices)]


def _flow_features(elevation, bbox):
    """Return normalized slope, convexity, and D8 flow accumulation."""
    terrain = np.asarray(elevation, dtype=np.float64)
    rows, columns = terrain.shape
    spacing_y = (bbox[3] - bbox[1]) / max(1, rows - 1)
    spacing_x = (bbox[2] - bbox[0]) / max(1, columns - 1)
    gradient_y, gradient_x = np.gradient(terrain, spacing_y, spacing_x)
    slope = np.hypot(gradient_x, gradient_y)

    gradient_yy = np.gradient(gradient_y, spacing_y, axis=0)
    gradient_xx = np.gradient(gradient_x, spacing_x, axis=1)
    curvature = gradient_xx + gradient_yy

    receiver = np.full((rows, columns), -1, dtype=np.int64)
    best_grade = np.zeros((rows, columns), dtype=np.float64)
    indices = np.arange(rows * columns, dtype=np.int64).reshape((rows, columns))
    for row_offset, column_offset in (
        (-1, -1), (-1, 0), (-1, 1), (0, -1),
        (0, 1), (1, -1), (1, 0), (1, 1),
    ):
        source_rows = slice(max(0, -row_offset), min(rows, rows - row_offset))
        source_columns = slice(max(0, -column_offset), min(columns, columns - column_offset))
        neighbor_rows = slice(max(0, row_offset), min(rows, rows + row_offset))
        neighbor_columns = slice(max(0, column_offset), min(columns, columns + column_offset))
        distance = np.hypot(row_offset * spacing_y, column_offset * spacing_x)
        grade = (
            terrain[source_rows, source_columns]
            - terrain[neighbor_rows, neighbor_columns]
        ) / distance
        current = best_grade[source_rows, source_columns]
        better = grade > current
        current[better] = grade[better]
        target = receiver[source_rows, source_columns]
        target[better] = indices[neighbor_rows, neighbor_columns][better]

    accumulation = np.ones(rows * columns, dtype=np.float64)
    receiver_flat = receiver.ravel()
    for index in np.argsort(terrain.ravel())[::-1]:
        target = receiver_flat[index]
        if target >= 0:
            accumulation[target] += accumulation[index]
    accumulation = np.log1p(accumulation.reshape((rows, columns)))

    def robust_unit(values, percentile=98):
        scale = np.percentile(np.abs(values), percentile)
        if scale <= 1e-12:
            return np.zeros_like(values)
        return np.clip(values / scale, -1.0, 1.0)

    return (
        np.clip(robust_unit(slope), 0.0, 1.0),
        robust_unit(curvature),
        np.clip(accumulation / max(np.percentile(accumulation, 99), 1e-12), 0.0, 1.0),
    )


def upscale_heightmap(
    heightmap,
    bbox,
    *,
    factor=4,
    seed=DEFAULT_SEED,
    amplitude_m=1.0,
    octaves=3,
    edge_fade_source_cells=1.0,
    water_mask=None,
):
    """Upscale a square DEM while retaining its measured constraints.

    ``bbox`` is ``(x_min, y_min, x_max, y_max)`` in a metric projected CRS.
    The output resolution is ``factor * (N - 1) + 1``, ensuring every source
    sample has an exact corresponding output vertex.
    """
    source = np.asarray(heightmap, dtype=np.float64)
    if source.ndim != 2 or source.shape[0] != source.shape[1]:
        raise ValueError("heightmap must be a square 2D array")
    if source.shape[0] < 2 or factor < 1 or int(factor) != factor:
        raise ValueError("factor must be a positive integer and heightmap at least 2x2")
    if not np.all(np.isfinite(source)):
        raise ValueError("heightmap contains non-finite values")
    if len(bbox) != 4 or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
        raise ValueError("bbox must be an increasing (x_min, y_min, x_max, y_max)")

    factor = int(factor)
    output_resolution = factor * (source.shape[0] - 1) + 1
    base = _bilinear(source, output_resolution)
    if factor == 1 or amplitude_m == 0:
        return base.astype(np.float32)

    x = np.linspace(bbox[0], bbox[2], output_resolution)[None, :]
    y = np.linspace(bbox[1], bbox[3], output_resolution)[:, None]
    source_spacing = 0.5 * (
        (bbox[2] - bbox[0]) / (source.shape[1] - 1)
        + (bbox[3] - bbox[1]) / (source.shape[0] - 1)
    )

    # Smoothly reach zero at every outer border. This keeps the exact repaired
    # seam curve even if a neighboring tile has not been upscaled yet.
    fade_width = max(1.0, float(edge_fade_source_cells) * factor)
    distance = np.minimum.reduce([
        np.arange(output_resolution, dtype=np.float64),
        np.arange(output_resolution - 1, -1, -1, dtype=np.float64),
    ])
    edge_window_1d = _smoothstep(np.clip(distance / fade_width, 0.0, 1.0))
    edge_window = np.minimum(edge_window_1d[:, None], edge_window_1d[None, :])

    result = base
    if amplitude_m != 0:
        result = base + float(amplitude_m) * _lattice_residual(
            source, base, x, y, source_spacing, bbox, factor,
            output_resolution, int(octaves), int(seed), float(amplitude_m),
        ) * edge_window

    if water_mask is not None:
        mask = np.asarray(water_mask, dtype=bool)
        if mask.shape != source.shape:
            raise ValueError("water mask shape must match heightmap")
        high_resolution_water = _nearest_mask(mask, output_resolution)
        # effective_heightmap defines water as sea level. Preserve that
        # contract instead of interpolating nearby land into masked water.
        result[high_resolution_water] = 0.0

    # Assignment avoids any floating-point roundoff at measured vertices.
    result[::factor, ::factor] = source
    result[0, :] = base[0, :]
    result[-1, :] = base[-1, :]
    result[:, 0] = base[:, 0]
    result[:, -1] = base[:, -1]
    return result.astype(np.float32)


def _lattice_residual(source, base, x, y, source_spacing, bbox, factor,
                      output_resolution, octaves, seed, amplitude_m):
    """The original lattice-bridged procedural residual (zero at every measured
    sample and at the border), including the drainage incision pass."""
    noise = _fbm(x, y, source_spacing * 2.0, int(octaves), int(seed))
    # Slow world-scale amplitude modulation keeps the synthetic relief from
    # reading as uniform stucco: some areas get rough, others stay calm,
    # coherently across tile borders. Applied before the lattice bridge so
    # measured samples remain exactly preserved.
    noise = noise * (0.35 + 0.65 * _smoothstep(np.clip(
        0.5 + 0.75 * _fbm(x, y, 900.0, 4, int(seed) ^ 0x414D50),
        0.0, 1.0,
    )))

    # A lattice bridge: subtract the interpolation of fBm at the measured DEM
    # lattice.  The residual is therefore exactly zero at every source sample.
    measured_noise = noise[::factor, ::factor]
    residual = noise - _bilinear(measured_noise, output_resolution)

    # Incise a deterministic drainage hierarchy into the same constrained
    # residual. Flow follows the measured landform plus fBm, so the generated
    # channels reinforce real downhill structure instead of floating over it.
    provisional = base + float(amplitude_m) * residual
    slope, _, flow = _flow_features(provisional, bbox)
    incision = -(flow ** 1.6) * np.sqrt(slope)
    incision -= _bilinear(incision[::factor, ::factor], output_resolution)
    return residual * 0.72 + incision * 0.55


def _read_south_first_mask(data):
    with Image.open(io.BytesIO(data)) as image:
        # Package PNG rasters are north-first; numerical terrain is south-first.
        return np.asarray(image.convert("L"), dtype=np.uint8)[::-1] != 0


def upscale_texture(texture_bytes, *, factor=4):
    """Deterministic Lanczos enlarge of tile imagery.

    The noise painter that used to live here is REMOVED (2026-07-22
    "dark shadow" artifacts, confirmed 2026-07-23): it repainted synthetic
    shading and grain over evenly-lit imagery and damaged tiles. Imagery now
    stays an honest enlarge of the parent photo.
    """
    if factor < 1 or int(factor) != factor:
        raise ValueError("texture factor must be a positive integer")
    factor = int(factor)
    with Image.open(io.BytesIO(texture_bytes)) as source_image:
        source = source_image.convert("RGB")
        size = (source.width * factor, source.height * factor)
        resized = source.resize(size, Image.Resampling.LANCZOS)
    output = io.BytesIO()
    resized.save(output, format="JPEG", quality=95, subsampling=0, optimize=True)
    return output.getvalue(), resized.size


def upscale_tile_package(
    input_path,
    output_path,
    *,
    factor=4,
    seed=DEFAULT_SEED,
    amplitude_m=1.0,
    octaves=3,
):
    """Write a minimal replacement bundle containing only changed files."""
    input_path = Path(input_path)
    output_path = Path(output_path)
    total_started = perf_counter()
    log_upscale.info(
        "Upscale started: input=%s output=%s factor=%dx seed=%d "
        "amplitude=%.3fm octaves=%d",
        input_path,
        output_path,
        factor,
        seed,
        amplitude_m,
        octaves,
    )

    read_started = perf_counter()
    with zipfile.ZipFile(input_path, "r") as source_archive:
        manifest = json.loads(source_archive.read("manifest.json"))
        heightmap = np.load(
            io.BytesIO(source_archive.read(manifest["heightmap"]["file"])),
            allow_pickle=False,
        )
        water_mask = None
        if manifest.get("masks", {}).get("effectiveWater"):
            water_mask = _read_south_first_mask(
                source_archive.read("effective-water-mask.png")
            )
        bbox = manifest["bbox"]["values"]
        texture_file = manifest.get("texture", {}).get("file", "texture-final.jpg")
        texture_bytes = source_archive.read(texture_file)
        read_seconds = perf_counter() - read_started
        tile_id = manifest.get("tileId") or input_path.stem
        log_upscale.info(
            "Read tile %s package in %.1fms (heightmap=%dx%d, texture=%s)",
            tile_id,
            read_seconds * 1000.0,
            heightmap.shape[1],
            heightmap.shape[0],
            texture_file,
        )

        heightmap_started = perf_counter()
        upscaled = upscale_heightmap(
            heightmap,
            bbox,
            factor=factor,
            seed=seed,
            amplitude_m=amplitude_m,
            octaves=octaves,
            water_mask=water_mask,
        )
        heightmap_seconds = perf_counter() - heightmap_started
        log_upscale.info(
            "Upscaled tile %s heightmap %dx%d -> %dx%d in %.1fms",
            tile_id,
            heightmap.shape[1],
            heightmap.shape[0],
            upscaled.shape[1],
            upscaled.shape[0],
            heightmap_seconds * 1000.0,
        )

        texture_started = perf_counter()
        upscaled_texture, texture_size = upscale_texture(
            texture_bytes, factor=factor,
        )
        texture_seconds = perf_counter() - texture_started
        log_upscale.info(
            "Upscaled tile %s texture to %dx%d in %.1fms",
            tile_id,
            texture_size[0],
            texture_size[1],
            texture_seconds * 1000.0,
        )

        output_manifest = {
            "format": "atlantis-terrain-tile-upscale-v1",
            "tileId": manifest.get("tileId"),
            "address": manifest.get("address"),
            "bbox": manifest["bbox"],
            "heightmap": {
                "file": "heightmap-upscaled.npy",
                "rawFile": "heightmap-upscaled.f32",
                "dtype": "float32",
                "shape": list(upscaled.shape),
                "rowOrder": "south-to-north",
                "method": "world_fbm_flow_erosion_bridge_v2",
                "factor": int(factor),
                "seed": int(seed),
                "amplitudeMeters": float(amplitude_m),
                "octaves": int(octaves),
                "sourceSamplesPreserved": True,
                "bordersPreserved": True,
            },
            "texture": {
                "file": "texture-upscaled.jpg",
                "format": "jpeg",
                "shape": [texture_size[1], texture_size[0]],
                "method": "lanczos",
                "factor": int(factor),
                "geographicLayoutPreserved": True,
            },
        }

        write_started = perf_counter()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as output_archive:
            output_archive.writestr(
                "manifest.json", json.dumps(output_manifest, indent=2, default=str)
            )
            buffer = io.BytesIO()
            np.save(buffer, upscaled, allow_pickle=False)
            output_archive.writestr("heightmap-upscaled.npy", buffer.getvalue())
            output_archive.writestr("heightmap-upscaled.f32", upscaled.tobytes())
            output_archive.writestr("texture-upscaled.jpg", upscaled_texture)
    write_seconds = perf_counter() - write_started
    total_seconds = perf_counter() - total_started
    log_upscale.info(
        "Upscale complete: tile=%s total=%.1fms read=%.1fms heightmap=%.1fms "
        "texture=%.1fms write=%.1fms output=%.1fKiB",
        tile_id,
        total_seconds * 1000.0,
        read_seconds * 1000.0,
        heightmap_seconds * 1000.0,
        texture_seconds * 1000.0,
        write_seconds * 1000.0,
        output_path.stat().st_size / 1024.0,
    )
    return upscaled


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--factor", type=int, default=4)
    parser.add_argument("--seed", type=lambda value: int(value, 0), default=DEFAULT_SEED)
    parser.add_argument("--amplitude", type=float, default=1.0, metavar="METERS")
    parser.add_argument("--octaves", type=int, default=3)
    args = parser.parse_args(argv)
    output = args.output or args.package.with_name(
        f"{args.package.stem}-upscaled.zip"
    )
    upscaled = upscale_tile_package(
        args.package,
        output,
        factor=args.factor,
        seed=args.seed,
        amplitude_m=args.amplitude,
        octaves=args.octaves,
    )
    print(f"wrote {output} ({upscaled.shape[1]}x{upscaled.shape[0]})")


if __name__ == "__main__":
    main()
