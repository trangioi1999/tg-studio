import { Component, computed, input, output } from '@angular/core';

export type MascotPose = 'idle' | 'coding' | 'thinking' | 'success' | 'sleep' | 'wave' | 'oops';

/** No art for a failure yet: the puzzled pose, shaken and greyed by CSS. */
const IMAGE: Record<Exclude<MascotPose, 'wave'>, string> = { idle: 'idle', coding: 'coding', thinking: 'thinking', success: 'success', sleep: 'sleep', oops: 'thinking' };

const LABEL: Record<MascotPose, string> = {
  idle: 'Mèo TG đang đứng chờ',
  coding: 'Mèo TG đang gõ code',
  thinking: 'Mèo TG đang suy nghĩ',
  success: 'Mèo TG ăn mừng',
  sleep: 'Mèo TG đang ngủ',
  wave: 'Mèo TG vẫy tay chào',
  oops: 'Mèo TG gặp lỗi',
};

/**
 * The app's cat. Each pose is a cut-out in `public/mascot/` (360×400); `wave` is a 5-frame sprite
 * played once, then `waved` fires so the host can go back to another pose. Motion is CSS only.
 */
@Component({
  selector: 'tg-mascot',
  template: `<span class="mascot" [attr.data-pose]="pose()" [style.width.px]="size()" [style.height.px]="height()" role="img" [attr.aria-label]="label()">
  @if (pose() === 'wave') {
    <span class="mascot-sprite" (animationend)="waved.emit()"></span>
  } @else {
    <img class="mascot-img" [src]="'mascot/' + image() + '.webp'" alt="" draggable="false" />
  }
  @if (pose() === 'sleep') {
    <span class="mascot-z" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>
  }
</span>`,
})
export class Mascot {
  readonly pose = input<MascotPose>('idle');
  /** Width in px; the height follows the 360×400 frames. */
  readonly size = input(120);
  readonly waved = output<void>();
  protected readonly height = computed(() => Math.round((this.size() * 400) / 360));
  protected readonly label = computed(() => LABEL[this.pose()]);
  protected readonly image = computed(() => IMAGE[this.pose() as Exclude<MascotPose, 'wave'>]);
}
