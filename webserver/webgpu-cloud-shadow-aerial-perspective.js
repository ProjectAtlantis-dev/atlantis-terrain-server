import { hash } from 'three/src/nodes/core/NodeUtils.js';
import {
  Fn,
  If,
  mix,
  positionGeometry,
  remapClamp,
  select,
  uv,
  vec3,
  vec4
} from 'three/tsl';
import {
  AerialPerspectiveNode,
  getSkyLuminanceToPoint,
  getSunAndSkyIlluminance
} from '@takram/three-atmosphere/webgpu';
import {
  cameraFar,
  cameraNear,
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  rayEllipsoidIntersection,
  screenToPositionView
} from '@takram/three-geospatial/webgpu';

// Project-owned adapter for the first WebGPU cloud-shadow integration point.
// Takram's node keeps direct and indirect surface illuminance separate, but it
// does not expose a surface-shadow input. Keep the change here instead of in
// the ignored local three-geospatial checkout.
export class CloudShadowAerialPerspectiveNode extends AerialPerspectiveNode {
  static get type() {
    return 'CloudShadowAerialPerspectiveNode';
  }

  constructor(atmosphereContext, colorNode, depthNode, normalNode, cloudShadow) {
    super(atmosphereContext, colorNode, depthNode, normalNode);
    this.cloudShadow = cloudShadow;
  }

  customCacheKey() {
    return hash(super.customCacheKey(), +Boolean(this.cloudShadow));
  }

  setup(builder) {
    const camera = this.atmosphereContext.camera ?? builder.camera;
    if (camera == null) {
      return;
    }

    builder.getContext().atmosphere = this.atmosphereContext;

    const {
      ellipsoid,
      worldToUnit,
      matrixWorldToECEF,
      sunDirectionECEF,
      cameraPositionUnit,
      altitudeCorrectionECEF,
      altitudeCorrectionUnit
    } = this.atmosphereContext;

    const { colorNode, depthNode, normalNode } = this;
    const depth = depthNode.r.toVar();

    const getSurfacePositionECEF = () => {
      const viewZ = depthToViewZ(depth, cameraNear(camera), cameraFar(camera), {
        perspective: camera.isPerspectiveCamera,
        logarithmic: builder.renderer.logarithmicDepthBuffer
      });
      const positionView = screenToPositionView(
        uv(),
        depth,
        viewZ,
        projectionMatrix(camera),
        inverseProjectionMatrix(camera)
      );
      const positionWorld = inverseViewMatrix(camera).mul(
        vec4(positionView, 1)
      ).xyz;
      return matrixWorldToECEF.mul(vec4(positionWorld, 1)).xyz;
    };

    const getRayDirectionECEF = () => {
      const positionView = inverseProjectionMatrix(camera).mul(
        vec4(positionGeometry, 1)
      ).xyz;
      const directionWorld = inverseViewMatrix(camera).mul(
        vec4(positionView, 0)
      ).xyz;
      const directionECEF = matrixWorldToECEF.mul(
        vec4(directionWorld, 0)
      ).xyz;
      return directionECEF.toVertexStage().normalize();
    };

    const surfaceLuminance = Fn(() => {
      const positionECEF = getSurfacePositionECEF().toVar();
      const positionUnit = positionECEF.mul(worldToUnit).toVar();
      const shadowPositionECEF = this.atmosphereContext.correctAltitude
        ? positionECEF.add(altitudeCorrectionECEF)
        : positionECEF;
      const cloudTransmittance = this.cloudShadow.getTransmittanceNode(
        shadowPositionECEF
      );

      const geometryCorrectionAmount = remapClamp(
        positionUnit.distance(cameraPositionUnit),
        worldToUnit.mul(336_000),
        worldToUnit.mul(876_000)
      );

      const radiiUnit = vec3(ellipsoid.radii).mul(worldToUnit);
      const normalCorrected = positionUnit.div(radiiUnit.pow2()).normalize();

      if (this.correctGeometricError) {
        const rayDirectionECEF = getRayDirectionECEF();
        const intersection = rayEllipsoidIntersection(
          cameraPositionUnit,
          rayDirectionECEF,
          radiiUnit
        ).x;

        const positionCorrected = select(
          intersection.greaterThanEqual(0),
          rayDirectionECEF.mul(intersection).add(cameraPositionUnit),
          normalCorrected.mul(radiiUnit)
        );
        positionUnit.assign(
          mix(positionUnit, positionCorrected, geometryCorrectionAmount)
        );
      }

      const illuminance = Fn(() => {
        let normalECEF;
        if (normalNode != null) {
          const normalView = normalNode.xyz;
          const normalWorld = inverseViewMatrix(camera).mul(
            vec4(normalView, 0)
          ).xyz;
          normalECEF = matrixWorldToECEF.mul(vec4(normalWorld, 0)).xyz;

          if (this.correctGeometricError) {
            normalECEF.assign(
              mix(normalECEF, normalCorrected, geometryCorrectionAmount)
            );
          }
        } else {
          normalECEF = positionUnit.normalize();
        }

        const sunSkyIlluminance = getSunAndSkyIlluminance(
          positionUnit.add(altitudeCorrectionUnit),
          normalECEF,
          sunDirectionECEF
        );
        let sunIlluminance = sunSkyIlluminance.get('sunIlluminance');
        const skyIlluminance = sunSkyIlluminance.get('skyIlluminance');

        sunIlluminance = sunIlluminance.mul(cloudTransmittance);
        return sunIlluminance.add(skyIlluminance);
      })();

      const diffuse = this.lighting
        ? colorNode.rgb.mul(illuminance).mul(1 / Math.PI)
        : colorNode.rgb;

      const luminanceTransfer = getSkyLuminanceToPoint(
        cameraPositionUnit.add(altitudeCorrectionUnit),
        positionUnit.add(altitudeCorrectionUnit),
        this.shadowLengthNode ?? 0,
        sunDirectionECEF
      ).toVar();
      const inscatter = luminanceTransfer.get('luminance');
      const transmittance = luminanceTransfer.get('transmittance');

      let output = diffuse;
      if (this.transmittance) {
        output = output.mul(transmittance);
      }
      if (this.inscatter) {
        output = output.add(inscatter);
      }
      return select(
        this.cloudShadow.debugSurface,
        vec3(cloudTransmittance),
        output
      );
    })().context(builder.getContext());

    return Fn(() => {
      const luminance = colorNode.toVar();
      If(depth.greaterThanEqual(1), () => {
        if (this.skyNode != null) {
          luminance.rgb.assign(this.skyNode);
        }
      }).Else(() => {
        luminance.rgb.assign(surfaceLuminance);
      });
      return luminance;
    })();
  }
}

export const cloudShadowAerialPerspective = (
  atmosphereContext,
  colorNode,
  depthNode,
  normalNode,
  cloudShadow
) => new CloudShadowAerialPerspectiveNode(
  atmosphereContext,
  colorNode,
  depthNode,
  normalNode,
  cloudShadow
);
