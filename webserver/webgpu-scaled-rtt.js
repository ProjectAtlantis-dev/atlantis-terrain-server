import * as THREE from 'three/webgpu';
import { RTTNode } from 'three/webgpu';

// RTTNode follows the full drawing-buffer size by default. Post effects whose
// signal is deliberately low-frequency can use this node to own a stable
// fraction of that resolution without changing the scene render target.
const sizeScratch = new THREE.Vector2();

export class ScaledRTTNode extends RTTNode {
  constructor(node, resolutionScale) {
    super(node, 1, 1);
    this.resolutionScale = resolutionScale;
  }

  setResolutionScale(resolutionScale) {
    if (Number.isFinite(resolutionScale) && resolutionScale > 0 && resolutionScale <= 1) {
      this.resolutionScale = resolutionScale;
    }
  }

  updateBefore(frame) {
    const size = frame.renderer.getDrawingBufferSize(sizeScratch);
    const width = Math.max(1, Math.floor(size.width * this.resolutionScale));
    const height = Math.max(1, Math.floor(size.height * this.resolutionScale));
    if (width !== this.renderTarget.width || height !== this.renderTarget.height) {
      this.setSize(width, height);
    }
    super.updateBefore(frame);
  }
}
