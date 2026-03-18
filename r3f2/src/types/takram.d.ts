// Type declarations for @takram packages (resolved via Vite aliases to local source)
// These packages use decorators, raw shader imports, and other build-specific features
// that don't work with standard TS checking. We declare them as modules with typed exports.

declare module '@takram/three-atmosphere' {
  import type * as THREE from 'three';

  export class AerialPerspectiveEffect {
    constructor(camera: THREE.Camera, options?: any);
    sky: boolean;
    sun: boolean;
    sunIrradiance: boolean;
    skyIrradiance: boolean;
    inscatter: boolean;
    normalBuffer: THREE.Texture | null;
    albedoScale: number;
    shadowRadius: number;
    shadowSampleCount: number;
    sunDirection: THREE.Vector3;
    overlay: any;
    shadow: any;
    shadowLength: any;
    [key: string]: any;
  }

  export class PrecomputedTexturesLoader {
    constructor(options?: any, manager?: THREE.LoadingManager);
    load(
      url: string,
      onLoad?: (textures: any) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (error: any) => void
    ): void;
  }

  export function getSunDirectionECEF(date: Date, target: THREE.Vector3): THREE.Vector3;
}

declare module '@takram/three-clouds' {
  import type * as THREE from 'three';

  export class CloudsEffect {
    constructor(camera: THREE.Camera, options?: any);
    qualityPreset: string;
    coverage: number;
    cloudLayers: any[];
    localWeatherVelocity: THREE.Vector2;
    shapeVelocity: THREE.Vector3;
    shapeDetailVelocity: THREE.Vector3;
    shadow: any;
    localWeatherTexture: any;
    shapeTexture: any;
    shapeDetailTexture: any;
    turbulenceTexture: any;
    sunDirection: THREE.Vector3;
    clouds: any;
    turbulenceDisplacement: number;
    scatteringCoefficient: number;
    absorptionCoefficient: number;
    atmosphereOverlay: any;
    atmosphereShadow: any;
    atmosphereShadowLength: any;
    events: {
      addEventListener(type: string, listener: (event: any) => void): void;
    };
    [key: string]: any;
  }

  export class CloudShape {
    constructor();
  }
  export class CloudShapeDetail {
    constructor();
  }
  export class LocalWeather {
    constructor();
  }
  export class Turbulence {
    constructor();
  }
}

declare module '@takram/three-geospatial-effects' {
  export class DitheringEffect {
    constructor();
    [key: string]: any;
  }
}

declare module '@takram/three-geospatial' {
  import type * as THREE from 'three';

  export const radians: (degrees: number) => number;

  export class Ellipsoid {
    static WGS84: Ellipsoid;
    getEastNorthUpFrame(position: THREE.Vector3, result?: THREE.Matrix4): THREE.Matrix4;
    getEastNorthUpVectors(
      position: THREE.Vector3,
      east?: THREE.Vector3,
      north?: THREE.Vector3,
      up?: THREE.Vector3
    ): void;
    getSurfaceNormal(position: THREE.Vector3, result?: THREE.Vector3): THREE.Vector3;
  }

  export class Geodetic {
    longitude: number;
    latitude: number;
    height: number;
    constructor(longitude?: number, latitude?: number, height?: number);
    toECEF(ellipsoid?: Ellipsoid, result?: THREE.Vector3): THREE.Vector3;
  }
}
