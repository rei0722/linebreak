// Keyboard → engine input codes. The engine does DAS/ARR itself, so we only
// forward physical press/release edges and ignore the OS key-repeat.

import { Input } from '../../../shared/engine/game';

export type Action = 'left' | 'right' | 'soft' | 'cw' | 'ccw' | 'hard' | 'hold' | 'menu';

export const KEYMAP: Record<string, Action> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowDown: 'soft',
  ArrowUp: 'cw',
  KeyX: 'cw',
  KeyZ: 'ccw',
  Space: 'hard',
  KeyC: 'hold',
  ShiftLeft: 'hold',
  ShiftRight: 'hold',
  Escape: 'menu',
};

/** Some environments (remote desktops, automation, odd layouts) send an empty `code`. */
const KEY_FALLBACK: Record<string, string> = {
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowDown: 'ArrowDown',
  ArrowUp: 'ArrowUp',
  ' ': 'Space',
  Shift: 'ShiftLeft',
  Escape: 'Escape',
  x: 'KeyX',
  X: 'KeyX',
  z: 'KeyZ',
  Z: 'KeyZ',
  c: 'KeyC',
  C: 'KeyC',
};
const keyId = (e: KeyboardEvent) => e.code || KEY_FALLBACK[e.key] || '';

const PRESS: Partial<Record<Action, number>> = {
  left: Input.LeftDown,
  right: Input.RightDown,
  soft: Input.SoftDown,
  cw: Input.RotateCW,
  ccw: Input.RotateCCW,
  hard: Input.HardDrop,
  hold: Input.Hold,
};
const RELEASE: Partial<Record<Action, number>> = {
  left: Input.LeftUp,
  right: Input.RightUp,
  soft: Input.SoftUp,
};

export class KeyboardController {
  /** physical keys down (by code) */
  private down = new Set<string>();
  /** held directional actions in press order */
  private held: Action[] = [];
  enabled = true;

  constructor(
    private emit: (code: number) => void,
    private onMenu: () => void,
  ) {
    window.addEventListener('keydown', this.onDown, { capture: true });
    window.addEventListener('keyup', this.onUp, { capture: true });
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onDown = (e: KeyboardEvent) => {
    const id = keyId(e);
    const action = KEYMAP[id];
    if (!action || this.isTyping(e)) return;
    e.preventDefault(); // no page scroll on arrows / space, no button activation
    if (e.repeat || this.down.has(id)) return;
    this.down.add(id);
    if (action === 'menu') return this.onMenu();
    if (!this.enabled) return;
    // a second physical key for an already-held direction does nothing
    if (RELEASE[action] !== undefined) {
      if (this.held.includes(action)) return;
      this.held.push(action);
    }
    const code = PRESS[action];
    if (code !== undefined) this.emit(code);
  };

  private onUp = (e: KeyboardEvent) => {
    const id = keyId(e);
    const action = KEYMAP[id];
    if (!action) return;
    if (!this.down.delete(id)) return;
    if (RELEASE[action] === undefined) return;
    // still held through another key bound to the same action?
    for (const c of this.down) if (KEYMAP[c] === action) return;
    const i = this.held.indexOf(action);
    if (i < 0) return;
    this.held.splice(i, 1);
    if (this.enabled) this.emit(RELEASE[action]!);
  };

  releaseAll = () => {
    const held = this.held;
    this.held = [];
    this.down.clear();
    if (this.enabled) for (const a of held) this.emit(RELEASE[a]!);
  };

  private onVisibility = () => {
    if (document.hidden) this.releaseAll();
  };

  /** Press codes for keys currently held, oldest first (re-applied after a resync). */
  heldInputs(): number[] {
    return this.held.map((a) => PRESS[a]!);
  }

  dispose() {
    window.removeEventListener('keydown', this.onDown, { capture: true });
    window.removeEventListener('keyup', this.onUp, { capture: true });
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
