import * as THREE from 'three';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';

/**
 * Geodesy utilities for the Atlantis terrain system.
 *
 * The scene is rendered in a local ENU (East-North-Up) frame anchored at a
 * geodetic point (the "anchor"). terrainRoot is placed at the anchor position
 * with its axes aligned to the local east/north/up vectors.
 *
 * Coordinate system (terrainRoot-local):
 *   X = east (meters)
 *   Y = north (meters)
 *   Z = elevation (meters) — Z-up
 */

export interface ENUFrame {
  anchorGeodetic: Geodetic;
  anchorPosition: THREE.Vector3; // ECEF position
  east: THREE.Vector3;
  north: THREE.Vector3;
  up: THREE.Vector3;
}

export function createENUFrame(lat: number, lon: number): ENUFrame {
  const anchorGeodetic = new Geodetic(radians(lon), radians(lat), 0);
  const anchorPosition = anchorGeodetic.toECEF();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const up = new THREE.Vector3();
  Ellipsoid.WGS84.getEastNorthUpVectors(anchorPosition, east, north, up);
  return { anchorGeodetic, anchorPosition, east, north, up };
}

/**
 * Convert terrainRoot-local XY to geographic lat/lon.
 */
export function localToLatLon(
  localX: number,
  localY: number,
  anchorLat: number,
  anchorLon: number
): { lat: number; lon: number } {
  const lat = anchorLat + localY / 111320;
  const lon = anchorLon + localX / (111320 * Math.cos((anchorLat * Math.PI) / 180));
  return { lat, lon };
}

/**
 * Convert geographic lat/lon to terrainRoot-local XY.
 */
export function latLonToLocal(
  lat: number,
  lon: number,
  anchorLat: number,
  anchorLon: number
): { x: number; y: number } {
  const x = (lon - anchorLon) * 111320 * Math.cos((anchorLat * Math.PI) / 180);
  const y = (lat - anchorLat) * 111320;
  return { x, y };
}

/**
 * Create the terrainRoot transform matrix from an ENU frame.
 * Places terrainRoot at the anchor ECEF position with local Z-up orientation.
 */
export function computeTerrainRootTransform(
  enu: ENUFrame
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  // Build the ENU frame matrix: columns = [east, north, up, anchorPosition]
  const mat = new THREE.Matrix4();
  mat.makeBasis(enu.east, enu.north, enu.up);
  mat.setPosition(enu.anchorPosition);

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mat.decompose(position, quaternion, scale);

  return { position, quaternion };
}

/**
 * Get the camera position in geographic coordinates from world position.
 */
export function worldPositionToLatLon(
  worldPos: THREE.Vector3,
  enu: ENUFrame
): { lat: number; lon: number; altitude: number } {
  const offset = new THREE.Vector3().subVectors(worldPos, enu.anchorPosition);
  const localEast = offset.dot(enu.east);
  const localNorth = offset.dot(enu.north);
  const altitude = offset.dot(enu.up);

  const anchorLat = THREE.MathUtils.radToDeg(enu.anchorGeodetic.latitude);
  const anchorLon = THREE.MathUtils.radToDeg(enu.anchorGeodetic.longitude);

  const { lat, lon } = localToLatLon(localEast, localNorth, anchorLat, anchorLon);
  return { lat, lon, altitude };
}
