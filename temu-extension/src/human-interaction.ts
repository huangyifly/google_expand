/**
 * 拟人点击与懒加载滚动工具。
 * 这些方法设计成纯浏览器环境可运行的轻量实现，后续可以直接迁入 content script。
 */

export interface Point {
  clientX: number;
  clientY: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const inv = 1 - t;
  return inv ** 3 * p0 + 3 * inv ** 2 * t * p1 + 3 * inv * t ** 2 * p2 + t ** 3 * p3;
}

export function getSafePoint(element: Element): Point | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;

  return {
    clientX: rect.left + rect.width * (0.28 + Math.random() * 0.34),
    clientY: rect.top + rect.height * (0.22 + Math.random() * 0.46)
  };
}

export async function humanClick(element: Element): Promise<void> {
  const point = getSafePoint(element);
  if (!point) throw new Error('No safe point for humanClick');

  const duration = randomInt(800, 1500);
  const steps = Math.max(24, Math.floor(duration / 16));
  const startX = point.clientX + randomInt(-180, -60);
  const startY = point.clientY + randomInt(-90, 90);
  const cp1x = startX + (point.clientX - startX) * 0.28 + randomInt(-30, 30);
  const cp1y = startY + randomInt(-80, 80);
  const cp2x = startX + (point.clientX - startX) * 0.72 + randomInt(-30, 30);
  const cp2y = point.clientY + randomInt(-60, 60);

  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const x = cubicBezier(startX, cp1x, cp2x, point.clientX, t);
    const y = cubicBezier(startY, cp1y, cp2y, point.clientY, t);
    element.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      view: window
    }));
    await sleep(Math.max(8, Math.floor(duration / steps)));
  }

  await sleep(randomInt(80, 160));
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.clientX,
      clientY: point.clientY,
      view: window
    }));
  }

  await sleep(randomInt(400, 1200));
  element.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 1,
    clientX: point.clientX,
    clientY: point.clientY,
    view: window
  }));
  await sleep(randomInt(70, 180));
  element.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 0,
    clientX: point.clientX,
    clientY: point.clientY,
    view: window
  }));
  await sleep(randomInt(40, 120));
  element.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 0,
    clientX: point.clientX,
    clientY: point.clientY,
    view: window
  }));
}

export async function simulateSlowLazyLoad(steps = 2): Promise<void> {
  for (let index = 0; index < steps; index += 1) {
    window.scrollBy({
      top: randomInt(800, 1500),
      behavior: 'smooth'
    });
    await sleep(randomInt(1500, 3000));

    const jitter = randomInt(-16, 16);
    window.scrollBy({ left: jitter, top: 0, behavior: 'auto' });
    await sleep(randomInt(80, 180));
    window.scrollBy({ left: -jitter, top: 0, behavior: 'auto' });
    await sleep(randomInt(180, 320));
  }
}
