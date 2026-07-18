"""Query-time terrain seam repair.

The repair operates only on the tile dictionaries passed by the caller. It
does not read or write SQLite, which keeps geometry repair independently
testable and makes any future cache boundary explicit.
"""

import numpy as np


def repair_lod_seams(tiles):
    """Make rendered tile edges agree, modifying heightmaps in place.

    Same-depth neighbors share the average of their two boundary samples.
    When a same-depth neighbor is absent but a coarser rendered tile covers
    that area, the fine boundary is sampled from the coarse heightmap so it
    follows the exact edge represented by the coarse mesh.

    Returns counters describing the repairs performed.
    """
    repairs = {"same_depth": 0, "cross_lod": 0}
    if not tiles:
        return repairs

    by_address = {}
    for tile in tiles:
        depth, col, row = _tile_address(tile["id"])
        by_address[(depth, col, row)] = tile

    for tile in tiles:
        heightmap = tile["heightmap"]
        if heightmap is None:
            continue

        depth, col, row = _tile_address(tile["id"])
        neighbors = {
            "west": (depth, col - 1, row),
            "east": (depth, col + 1, row),
            "south": (depth, col, row - 1),
            "north": (depth, col, row + 1),
        }

        for direction, address in neighbors.items():
            _, neighbor_col, neighbor_row = address
            if neighbor_col < 0 or neighbor_row < 0:
                continue

            neighbor = by_address.get(address)
            if neighbor is not None:
                neighbor_heightmap = neighbor["heightmap"]
                if neighbor_heightmap is None:
                    continue
                # Each same-depth pair is repaired once. West and south are
                # handled when their neighbor visits its east or north edge.
                if direction == "east":
                    average = (heightmap[:, -1] + neighbor_heightmap[:, 0]) * 0.5
                    heightmap[:, -1] = average
                    neighbor_heightmap[:, 0] = average
                    repairs["same_depth"] += 1
                elif direction == "north":
                    average = (heightmap[-1, :] + neighbor_heightmap[0, :]) * 0.5
                    heightmap[-1, :] = average
                    neighbor_heightmap[0, :] = average
                    repairs["same_depth"] += 1
                continue

            coarse = find_coarser_covering_tile(
                by_address, depth, col, row, direction
            )
            if coarse is None or coarse["heightmap"] is None:
                continue

            resample_coarse_edge(
                heightmap,
                tile["bbox"],
                coarse["heightmap"],
                coarse["bbox"],
                direction,
            )
            repairs["cross_lod"] += 1

    return repairs


def find_coarser_covering_tile(by_address, depth, col, row, direction):
    """Find the rendered coarser leaf covering a missing neighbor."""
    if direction == "west":
        neighbor_col, neighbor_row = col - 1, row
    elif direction == "east":
        neighbor_col, neighbor_row = col + 1, row
    elif direction == "south":
        neighbor_col, neighbor_row = col, row - 1
    elif direction == "north":
        neighbor_col, neighbor_row = col, row + 1
    else:
        return None

    coarse_depth = depth
    for _ in range(depth):
        coarse_depth -= 1
        neighbor_col //= 2
        neighbor_row //= 2
        coarse = by_address.get((coarse_depth, neighbor_col, neighbor_row))
        if coarse is not None:
            return coarse
    return None


def resample_coarse_edge(fine_heightmap, fine_bbox, coarse_heightmap,
                         coarse_bbox, direction):
    """Overwrite one fine boundary with samples from a coarse heightmap."""
    sample_count = fine_heightmap.shape[0]
    fine_x_min, fine_y_min, fine_x_max, fine_y_max = fine_bbox
    coarse_x_min, coarse_y_min, coarse_x_max, coarse_y_max = coarse_bbox

    if direction == "west":
        edge_x = np.full(sample_count, fine_x_min)
        edge_y = np.linspace(fine_y_min, fine_y_max, sample_count)
    elif direction == "east":
        edge_x = np.full(sample_count, fine_x_max)
        edge_y = np.linspace(fine_y_min, fine_y_max, sample_count)
    elif direction == "south":
        edge_x = np.linspace(fine_x_min, fine_x_max, sample_count)
        edge_y = np.full(sample_count, fine_y_min)
    elif direction == "north":
        edge_x = np.linspace(fine_x_min, fine_x_max, sample_count)
        edge_y = np.full(sample_count, fine_y_max)
    else:
        raise ValueError(f"unknown seam direction: {direction}")

    coarse_rows, coarse_cols = coarse_heightmap.shape
    x_fraction = (
        (edge_x - coarse_x_min) / (coarse_x_max - coarse_x_min)
        * (coarse_cols - 1)
    )
    y_fraction = (
        (edge_y - coarse_y_min) / (coarse_y_max - coarse_y_min)
        * (coarse_rows - 1)
    )

    x0 = np.clip(np.floor(x_fraction).astype(int), 0, coarse_cols - 2)
    y0 = np.clip(np.floor(y_fraction).astype(int), 0, coarse_rows - 2)
    x1 = x0 + 1
    y1 = y0 + 1
    x_amount = x_fraction - x0
    y_amount = y_fraction - y0

    values = (
        coarse_heightmap[y0, x0] * (1 - x_amount) * (1 - y_amount)
        + coarse_heightmap[y0, x1] * x_amount * (1 - y_amount)
        + coarse_heightmap[y1, x0] * (1 - x_amount) * y_amount
        + coarse_heightmap[y1, x1] * x_amount * y_amount
    )

    if direction == "west":
        fine_heightmap[:, 0] = values
    elif direction == "east":
        fine_heightmap[:, -1] = values
    elif direction == "south":
        fine_heightmap[0, :] = values
    else:
        fine_heightmap[-1, :] = values


def _tile_address(tile_id):
    depth, col, row = tile_id.split("-")
    return int(depth), int(col), int(row)
