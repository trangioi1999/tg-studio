import { TestBed } from '@angular/core/testing';
import { Mascot } from './mascot';

describe('Mascot', () => {
  function make(pose: string, size = 90) {
    const f = TestBed.createComponent(Mascot);
    f.componentRef.setInput('pose', pose);
    f.componentRef.setInput('size', size);
    f.detectChanges();
    return f;
  }

  it('shows the cut-out of the pose, sized to the 360×400 frame', () => {
    const el: HTMLElement = make('coding').nativeElement;
    expect(el.querySelector('img')!.getAttribute('src')).toBe('mascot/coding.webp');
    const box = el.querySelector<HTMLElement>('.mascot')!;
    expect(box.style.width).toBe('90px');
    expect(box.style.height).toBe('100px');
    expect(box.getAttribute('aria-label')).toBe('Mèo TG đang gõ code');
  });

  it('plays the wave sprite and says when it is done', () => {
    const f = make('wave');
    let done = 0;
    f.componentInstance.waved.subscribe(() => done++);
    const sprite = f.nativeElement.querySelector('.mascot-sprite') as HTMLElement;
    expect(f.nativeElement.querySelector('img')).toBeNull();
    sprite.dispatchEvent(new Event('animationend'));
    expect(done).toBe(1);
  });

  it('adds the floating z only while asleep', () => {
    expect(make('sleep').nativeElement.querySelector('.mascot-z')).not.toBeNull();
    expect(make('idle').nativeElement.querySelector('.mascot-z')).toBeNull();
  });
});
