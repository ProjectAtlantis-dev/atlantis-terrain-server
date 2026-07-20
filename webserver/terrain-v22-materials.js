import * as THREE from 'three';

const BODY_MATERIAL_NAMES = new Set(['defaultwhite']);
const GLASS_MATERIAL_NAMES = new Set(['transparent']);

function loadTexture(loader, url, colorSpace = THREE.NoColorSpace) {
  const texture = loader.load(url);
  texture.name = url.split('/').pop() ?? url;
  texture.flipY = false;
  texture.colorSpace = colorSpace;
  return texture;
}

export function loadV22TextureSet(
  loader = new THREE.TextureLoader(),
  baseUrl = '/models/v22_textures',
) {
  return {
    bodyAlbedo: loadTexture(loader, `${baseUrl}/body_albedo.png`, THREE.SRGBColorSpace),
    bodyMetallic: loadTexture(loader, `${baseUrl}/body_metallic.png`),
    bodyNormal: loadTexture(loader, `${baseUrl}/body_normal.png`),
    bodyRoughness: loadTexture(loader, `${baseUrl}/body_roughness.png`),
    glassDiffuse: loadTexture(loader, `${baseUrl}/glass_diffuse.png`, THREE.SRGBColorSpace),
    glassRoughness: loadTexture(loader, `${baseUrl}/glass_roughness.png`),
  };
}

export function applyV22Materials(model, textures) {
  const applied = { body: 0, glass: 0 };
  const visited = new Set();
  model.traverse(object => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material == null || visited.has(material)) continue;
      visited.add(material);
      const name = String(material.name ?? '').trim().toLowerCase();
      if (BODY_MATERIAL_NAMES.has(name)) {
        material.map = textures.bodyAlbedo;
        material.metalnessMap = textures.bodyMetallic;
        material.normalMap = textures.bodyNormal;
        material.roughnessMap = textures.bodyRoughness;
        material.metalness = 1;
        material.roughness = 1;
        material.needsUpdate = true;
        applied.body += 1;
      } else if (GLASS_MATERIAL_NAMES.has(name)) {
        material.map = textures.glassDiffuse;
        material.roughnessMap = textures.glassRoughness;
        material.roughness = 1;
        material.transparent = true;
        material.depthWrite = false;
        material.needsUpdate = true;
        applied.glass += 1;
      }
    }
  });
  return applied;
}
