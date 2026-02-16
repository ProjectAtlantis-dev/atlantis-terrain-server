#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

class NodeFileReader {
  constructor() {
    this.result = null;
    this.onloadend = null;
    this.onerror = null;
  }

  async readAsArrayBuffer(blob) {
    try {
      this.result = await blob.arrayBuffer();
      if (typeof this.onloadend === 'function') {
        this.onloadend({ target: this });
      }
    } catch (error) {
      if (typeof this.onerror === 'function') {
        this.onerror(error);
      } else {
        throw error;
      }
    }
  }

  async readAsDataURL(blob) {
    try {
      const buffer = Buffer.from(await blob.arrayBuffer());
      const mime = blob.type || 'application/octet-stream';
      this.result = `data:${mime};base64,${buffer.toString('base64')}`;
      if (typeof this.onloadend === 'function') {
        this.onloadend({ target: this });
      }
    } catch (error) {
      if (typeof this.onerror === 'function') {
        this.onerror(error);
      } else {
        throw error;
      }
    }
  }
}

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = NodeFileReader;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../public/models/house_test.glb');

function buildHouseAsset() {
  const root = new THREE.Group();
  const houseWidth = 14;
  const houseDepth = 10;
  const wallHeight = 5;
  const roofHeight = 3.2;

  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(houseWidth, wallHeight, houseDepth),
    new THREE.MeshBasicMaterial({ color: 0xe2be93 })
  );
  walls.position.set(0, wallHeight * 0.5, 0);

  const roofShape = new THREE.Shape();
  roofShape.moveTo(-houseWidth * 0.5, 0);
  roofShape.lineTo(0, roofHeight);
  roofShape.lineTo(houseWidth * 0.5, 0);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, {
    depth: houseDepth,
    bevelEnabled: false,
    steps: 1,
  });
  roofGeo.translate(0, wallHeight, -houseDepth * 0.5);
  const roof = new THREE.Mesh(
    roofGeo,
    new THREE.MeshBasicMaterial({ color: 0xa23c2b })
  );

  const chimney = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.8, 0.9),
    new THREE.MeshBasicMaterial({ color: 0x4a4a4a })
  );
  chimney.position.set(2.5, wallHeight + roofHeight * 0.7, -1.4);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 2.4, 0.15),
    new THREE.MeshBasicMaterial({ color: 0x3f2a1f })
  );
  door.position.set(0, 1.2, houseDepth * 0.5 + 0.08);

  root.add(walls, roof, chimney, door);
  root.updateMatrixWorld(true);
  return root;
}

async function exportHouseGlb(outFilePath) {
  const exporter = new GLTFExporter();
  const sceneRoot = buildHouseAsset();
  const glb = await new Promise((resolve, reject) => {
    exporter.parse(
      sceneRoot,
      result => resolve(result),
      error => reject(error),
      { binary: true, onlyVisible: true, trs: false }
    );
  });

  if (!(glb instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter returned non-binary output.');
  }

  await fs.mkdir(path.dirname(outFilePath), { recursive: true });
  const bytes = Buffer.from(glb);
  await fs.writeFile(outFilePath, bytes);
  return bytes.length;
}

const size = await exportHouseGlb(outPath);
console.log(`[house-gen] wrote ${outPath} (${size} bytes)`);
