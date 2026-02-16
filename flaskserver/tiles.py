"""Quadtree tile system for LOD-based spatial queries in polar stereographic space.

Each tile is an axis-aligned rectangle in EPSG:3413 (meters). The quadtree
recursively subdivides tiles based on distance from a query point: nearby
tiles get more subdivision (higher detail), far tiles stay coarse.

Tile data format (saved to data/):
    {
        "bbox": [x_min, y_min, x_max, y_max],   # meters, EPSG:3413
        "depth": 3,                                # 0 = root, higher = more detail
        "center": [x, y],                          # tile center in meters
        "size": 369000.0,                           # tile edge length in meters
        "id": "0-2-1"                               # "depth-col-row"
    }
"""

import math
import numpy as np


# Default Greenland bounding box in EPSG:3413, padded to a square for clean subdivision
# Raw bounds: x=[-627247, 849164], y=[-3326128, -666027] (~1476km x 2660km)
# Padded to a square centered on the midpoint
_cx = (-627247 + 849164) / 2
_cy = (-3326128 + -666027) / 2
_half = 2700000 / 2  # larger dimension (2660km) + padding
GREENLAND_BBOX = (_cx - _half, _cy - _half, _cx + _half, _cy + _half)


class Tile:
    __slots__ = ("bbox", "depth", "children", "col", "row", "geometric_error")

    def __init__(self, bbox, depth=0, col=0, row=0):
        self.bbox = bbox  # (x_min, y_min, x_max, y_max)
        self.depth = depth
        self.col = col
        self.row = row
        self.children = None
        self.geometric_error = 0.0

    @property
    def x_min(self):
        return self.bbox[0]

    @property
    def y_min(self):
        return self.bbox[1]

    @property
    def x_max(self):
        return self.bbox[2]

    @property
    def y_max(self):
        return self.bbox[3]

    @property
    def center(self):
        return ((self.x_min + self.x_max) / 2, (self.y_min + self.y_max) / 2)

    @property
    def size(self):
        return self.x_max - self.x_min

    @property
    def id(self):
        return f"{self.depth}-{self.col}-{self.row}"

    @property
    def is_leaf(self):
        return self.children is None

    def area(self):
        return (self.x_max - self.x_min) * (self.y_max - self.y_min)

    def distance_to(self, x, y):
        """Distance from point (x, y) to nearest edge of this tile. 0 if inside."""
        dx = max(self.x_min - x, 0, x - self.x_max)
        dy = max(self.y_min - y, 0, y - self.y_max)
        return math.sqrt(dx * dx + dy * dy)

    def contains_point(self, x, y):
        return self.x_min <= x <= self.x_max and self.y_min <= y <= self.y_max

    def subdivide(self):
        """Split into 4 children (SW, SE, NW, NE)."""
        mx, my = self.center
        d = self.depth + 1
        c2, r2 = self.col * 2, self.row * 2
        self.children = [
            Tile((self.x_min, self.y_min, mx, my), d, c2, r2),        # SW
            Tile((mx, self.y_min, self.x_max, my), d, c2 + 1, r2),    # SE
            Tile((self.x_min, my, mx, self.y_max), d, c2, r2 + 1),    # NW
            Tile((mx, my, self.x_max, self.y_max), d, c2 + 1, r2 + 1),  # NE
        ]
        return self.children

    def to_dict(self):
        return {
            "bbox": list(self.bbox),
            "depth": self.depth,
            "center": list(self.center),
            "size": self.size,
            "id": self.id,
        }


def build_lod_tree(query_x, query_y, max_depth=4, lod_factor=2.0, bbox=None):
    """Build a quadtree with LOD based on distance from a query point.

    A tile is subdivided if:
        distance_to_tile < tile_size * lod_factor
    and depth < max_depth.

    Args:
        query_x, query_y: query point in EPSG:3413 meters
        max_depth: maximum subdivision depth (0 = just root)
        lod_factor: multiplier controlling how far LOD extends.
                    Higher = more tiles subdivided = more detail at distance.
        bbox: root bounding box, defaults to GREENLAND_BBOX

    Returns:
        root Tile with children populated
    """
    if bbox is None:
        bbox = GREENLAND_BBOX

    root = Tile(bbox)
    _subdivide_recursive(root, query_x, query_y, max_depth, lod_factor)
    return root


def _subdivide_recursive(tile, qx, qy, max_depth, lod_factor):
    if tile.depth >= max_depth:
        return
    dist = tile.distance_to(qx, qy)
    if dist < tile.size * lod_factor:
        children = tile.subdivide()
        for child in children:
            _subdivide_recursive(child, qx, qy, max_depth, lod_factor)


def get_leaves(root):
    """Return all leaf tiles from the tree as a flat list."""
    leaves = []
    _collect_leaves(root, leaves)
    return leaves


def _collect_leaves(tile, leaves):
    if tile.is_leaf:
        leaves.append(tile)
    else:
        for child in tile.children:
            _collect_leaves(child, leaves)


def query_tiles(query_x, query_y, max_depth=4, lod_factor=2.0, bbox=None):
    """Convenience: build tree and return leaf tiles as dicts.

    Returns list of tile dicts sorted by depth (highest first = most detail).
    """
    root = build_lod_tree(query_x, query_y, max_depth, lod_factor, bbox)
    leaves = get_leaves(root)
    return [t.to_dict() for t in sorted(leaves, key=lambda t: -t.depth)]
