// Minimal DOM builder: h('div.card', { onclick }, child, ...)
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any> | null;

export function h<K extends keyof HTMLElementTagNameMap>(sel: K | string, props?: Props, ...kids: Child[]): HTMLElement {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className += ` ${v}`;
      else if (k in el && k !== 'list') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Child[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
}

export const $ = (s: string) => document.querySelector(s) as HTMLElement;
export const clear = (el: HTMLElement) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(msg: string, opts: { err?: boolean; ms?: number; action?: [string, () => void] } = {}) {
  const t = h('div.toast' + (opts.err ? '.err' : ''), null, msg);
  if (opts.action) t.appendChild(h('button.btn.sm', { onclick: () => { opts.action![1](); t.remove(); } }, opts.action[0]));
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), opts.ms ?? 4500);
}

export function fmtMs(ms: number | null | undefined, plus = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--.---';
  const neg = ms < 0;
  const a = Math.abs(Math.round(ms));
  const m = Math.floor(a / 60000), s = Math.floor((a % 60000) / 1000), x = a % 1000;
  const body = `${m > 0 ? `${m}:${String(s).padStart(2, '0')}` : s}.${String(x).padStart(3, '0')}`;
  return (neg ? '-' : plus ? '+' : '') + body;
}

export function modal(title: string, body: Node, buttons: [string, () => void | boolean, string?][] = [['Close', () => {}]]) {
  const bg = h('div.modal-bg');
  const close = () => bg.remove();
  bg.appendChild(h('div.modal', null, h('h2', null, title), body,
    h('div.row', { style: { justifyContent: 'flex-end', marginTop: '16px' } },
      buttons.map(([label, fn, cls]) => h('button.btn' + (cls ? '.' + cls : ''), { onclick: () => { if (fn() !== false) close(); } }, label)))));
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $('#ui').appendChild(bg);
  return close;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const stars = (r: number | null) => r === null ? '—' : '★★★★★'.slice(0, Math.round(r)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(r));

/** Like Element.append but skips null/false children (for conditional UI). */
export function put(el: HTMLElement, ...kids: Child[]) { append(el, kids); return el; }
