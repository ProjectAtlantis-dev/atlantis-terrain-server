# Terrain segmentation

`segmentation.py` turns a cached RGB terrain texture plus its heightmap into
contiguous, image-oriented superpixels. These are region proposals for a later
semantic classifier; they are not the final `coarse_v1` class labels.

Each region follows a weighted combination of:

- CIE Lab color
- elevation
- slope
- local relief
- the sea-level boundary
- valid imagery versus black provider no-data

The default target diameter is 40 metres. Output statistics include RGB mean
and spread, elevation mean and spread, slope, relief, water fraction, imagery
validity, centroid, bounding box, and pixel count.

To inspect one cached tile:

```bash
cd flaskserver
venv/bin/python segment_tile.py 12-1372-784 --output /tmp/segments
```

This writes a lossless `labels.npy` raster, a boundary-overlay PNG, and JSON
region features. DEM rows are flipped internally from the database's
south-first convention into the texture's north-first image convention.
