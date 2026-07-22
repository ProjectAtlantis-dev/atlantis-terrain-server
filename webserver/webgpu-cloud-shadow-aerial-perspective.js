import { hash } from 'three/src/nodes/core/NodeUtils.js';
import {
  Fn,
  screenCoordinate,
  vec4,
  viewportUV,
} from 'three/tsl';
import {
  AerialPerspectiveNode,
  getAtmosphereContext,
} from '@takram/three-atmosphere/webgpu';
import {
  depthToViewZ,
  inverseProjectionMatrix,
  projectionMatrix,
  screenToPositionView,
} from '@takram/three-geospatial/webgpu';

// Adds the project cloud-transmittance field to the stock r184 aerial pass.
// The r184 atmosphere context is supplied by renderer.contextNode; it is no
// longer a constructor argument of AerialPerspectiveNode.
export class CloudShadowAerialPerspectiveNode extends AerialPerspectiveNode {
  static get type() {
    return 'AtlantisCloudAerialPerspectiveNode';
  }

  constructor(colorNode, depthNode, normalNode, cloudShadow) {
    super('CAMERA', colorNode, depthNode);
    this.normalNode = normalNode;
    this.lighting = true;
    this.cloudShadow = cloudShadow;
  }

  customCacheKey() {
    return hash(super.customCacheKey(), +Boolean(this.cloudShadow));
  }

  setup(builder) {
    if (this.cloudShadow == null) return super.setup(builder);

    const atmosphereContext = getAtmosphereContext(builder);
    const camera = atmosphereContext.camera ?? builder.camera;
    if (camera == null) return super.setup(builder);

    const sourceColorNode = this.colorNode;
    const depthNode = this.depthNode;
    const cloudShadow = this.cloudShadow;
    const cloudShadowedColor = Fn(() => {
      const depth = depthNode.load(screenCoordinate).r.toConst();
      const viewZ = depthToViewZ(depth, camera);
      const positionView = screenToPositionView(
        viewportUV,
        depth,
        viewZ,
        projectionMatrix(camera),
        inverseProjectionMatrix(camera),
      );
      let positionECEF = atmosphereContext.matrixViewToECEF
        .mul(vec4(positionView, 1))
        .xyz;
      if (atmosphereContext.correctAltitude) {
        positionECEF = positionECEF.add(atmosphereContext.altitudeCorrectionECEF);
      }
      const transmittance = cloudShadow.getTransmittanceNode(positionECEF);
      return vec4(sourceColorNode.rgb.mul(transmittance), sourceColorNode.a);
    })().context(builder.getContext());

    this.colorNode = cloudShadowedColor;
    try {
      return super.setup(builder);
    } finally {
      this.colorNode = sourceColorNode;
    }
  }
}

export const cloudShadowAerialPerspective = (
  colorNode,
  depthNode,
  normalNode,
  cloudShadow,
) => new CloudShadowAerialPerspectiveNode(
  colorNode,
  depthNode,
  normalNode,
  cloudShadow,
);
