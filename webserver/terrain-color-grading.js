import * as THREE from 'three';

export const TERRAIN_COLOR_GRADING_PRESETS = Object.freeze({
  off: Object.freeze({ label: 'Off', url: null }),
  natural: Object.freeze({
    label: 'Provia · natural',
    url: new URL(
      './three-geospatial/storybook/assets/clut/Fuji/Fuji Provia 100F.png',
      import.meta.url,
    ).href,
  }),
  vivid: Object.freeze({
    label: 'Velvia · vivid',
    url: new URL(
      './three-geospatial/storybook/assets/clut/Fuji/Fuji Velvia 50.png',
      import.meta.url,
    ).href,
  }),
  soft: Object.freeze({
    label: 'Astia · soft',
    url: new URL(
      './three-geospatial/storybook/assets/clut/Fuji/Fuji Astia 100F.png',
      import.meta.url,
    ).href,
  }),
});

// ImageMagick Hald images store an N^3 color cube as a square whose side is
// cubeRoot(N). The bundled 1728px film CLUTs therefore contain 144 samples per
// color axis. Preserve their linear pixel ordering while reducing them to a
// compact 48^3 GPU texture; the LUT shader interpolates between those samples.
export function haldImageDataTo3D(imageData, targetSize = 48) {
  const { width, height, data } = imageData;
  if (width !== height) throw new Error('Hald CLUT must be square');
  const haldLevel = Math.round(Math.cbrt(width));
  const sourceSize = haldLevel * haldLevel;
  if (haldLevel ** 3 !== width || sourceSize ** 3 !== width * height) {
    throw new Error(`unsupported Hald CLUT dimensions: ${width}x${height}`);
  }
  const output = new Uint8Array(targetSize ** 3 * 4);
  for (let blue = 0; blue < targetSize; blue += 1) {
    const sourceBlue = Math.round(blue * (sourceSize - 1) / (targetSize - 1));
    for (let green = 0; green < targetSize; green += 1) {
      const sourceGreen = Math.round(green * (sourceSize - 1) / (targetSize - 1));
      for (let red = 0; red < targetSize; red += 1) {
        const sourceRed = Math.round(red * (sourceSize - 1) / (targetSize - 1));
        const sourceIndex = sourceRed
          + sourceGreen * sourceSize
          + sourceBlue * sourceSize * sourceSize;
        const targetIndex = red
          + green * targetSize
          + blue * targetSize * targetSize;
        output[targetIndex * 4] = data[sourceIndex * 4];
        output[targetIndex * 4 + 1] = data[sourceIndex * 4 + 1];
        output[targetIndex * 4 + 2] = data[sourceIndex * 4 + 2];
        output[targetIndex * 4 + 3] = 255;
      }
    }
  }
  return output;
}

export async function loadTerrainColorGradingTexture(url, size = 48) {
  const image = await new THREE.ImageLoader().loadAsync(url);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context == null) throw new Error('could not create LUT conversion canvas');
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const texture = new THREE.Data3DTexture(
    haldImageDataTo3D(imageData, size),
    size,
    size,
    size,
  );
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  texture.name = `terrain-color-grade:${url.split('/').pop()}`;
  return texture;
}
