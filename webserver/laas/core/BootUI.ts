/** Boot overlay progress reporting (also mirrored to hooks for tooling). */

import type { LaasHooks } from './Hooks';

export class BootUI {
  private msg: HTMLElement | null;
  private bar: HTMLElement | null;
  private root: HTMLElement | null;
  private hooks: LaasHooks;

  constructor(hooks: LaasHooks) {
    this.hooks = hooks;
    this.msg = document.getElementById('boot-msg');
    this.bar = document.getElementById('boot-bar');
    this.root = document.getElementById('boot');
  }

  set(progress: number, message: string): void {
    this.hooks.progress = progress;
    this.hooks.progressMsg = message;
    if (this.msg) this.msg.textContent = message;
    if (this.bar) this.bar.style.width = `${Math.round(progress * 100)}%`;
  }

  hide(): void {
    this.set(1, 'ready');
    if (this.root) {
      this.root.style.opacity = '0';
      const el = this.root;
      setTimeout(() => {
        el.style.display = 'none';
      }, 600);
    }
  }
}
