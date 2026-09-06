-- Force a clean reload of the two depth-12 terrain subtrees.
-- Run against the active Terrain/Database/terrain.db with sqlite3.
-- Tile scaffolding (bounds, parent links, and IDs) is retained.

BEGIN IMMEDIATE;

DROP TABLE IF EXISTS temp.force_reload_tiles;
CREATE TEMP TABLE force_reload_tiles (tile_id TEXT PRIMARY KEY);

WITH RECURSIVE subtree(tile_id) AS (
  SELECT tile_id
    FROM tiles
   WHERE tile_id IN ('12-1978-92', '12-1978-93')
  UNION ALL
  SELECT child.tile_id
    FROM tiles AS child
    JOIN subtree AS parent ON child.parent_id = parent.tile_id
)
INSERT INTO force_reload_tiles(tile_id)
SELECT tile_id FROM subtree;

DELETE FROM bathymetry
 WHERE tile_id IN (SELECT tile_id FROM force_reload_tiles);
DELETE FROM tidal_connectivity_masks
 WHERE tile_id IN (SELECT tile_id FROM force_reload_tiles);
DELETE FROM hydrography_masks
 WHERE tile_id IN (SELECT tile_id FROM force_reload_tiles);
DELETE FROM coastline_masks
 WHERE tile_id IN (SELECT tile_id FROM force_reload_tiles);
DELETE FROM textures
 WHERE tile_id IN (SELECT tile_id FROM force_reload_tiles);

UPDATE tiles
   SET source = 'pending',
       vertical_datum = NULL,
       geometric_error = 0.0,
       heightmap = NULL,
       confidence_map = NULL,
       updated_at = CURRENT_TIMESTAMP,
       dem_demanded_at = NULL,
       dem_requested_at = NULL,
       cog_requested_at = NULL
 WHERE tile_id IN (SELECT tile_id FROM force_reload_tiles);

DROP TABLE force_reload_tiles;
COMMIT;
