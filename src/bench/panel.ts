/**
 * Bench panel UI helper. SPEC Section 8.1.
 *
 * Always-visible textarea at top-left với JSON dump + Blob download.
 * NO clipboard API (fails iOS Safari).
 *
 * Usage: panel = createBenchPanel(); panel.show(results);
 */
import type { BenchOutput } from '../data/types';

export interface BenchPanel {
  show: (results: BenchOutput[]) => void;
  hide: () => void;
  destroy: () => void;
}

export function createBenchPanel(): BenchPanel {
  const root = document.createElement('div');
  root.setAttribute('aria-label', 'Bench results panel');
  root.style.position = 'fixed';
  root.style.top = '8px';
  root.style.left = '8px';
  root.style.maxWidth = '380px';
  root.style.maxHeight = '50vh';
  root.style.background = 'rgba(0, 12, 28, 0.95)';
  root.style.border = '1px solid #00e5ff';
  root.style.padding = '8px';
  root.style.fontFamily = "'JetBrains Mono', 'SF Mono', Menlo, monospace";
  root.style.fontSize = '0.65rem';
  root.style.color = '#e0f7ff';
  root.style.zIndex = '1000';
  root.style.display = 'none';
  root.style.overflow = 'auto';

  const title = document.createElement('div');
  title.textContent = '◆ BENCH RESULTS';
  title.style.color = '#00e5ff';
  title.style.marginBottom = '6px';
  title.style.letterSpacing = '0.15em';
  root.appendChild(title);

  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.style.width = '100%';
  ta.style.height = '180px';
  ta.style.background = '#000814';
  ta.style.color = '#00e5ff';
  ta.style.border = '1px solid #0088aa';
  ta.style.fontFamily = 'inherit';
  ta.style.fontSize = '0.6rem';
  ta.style.padding = '4px';
  root.appendChild(ta);

  const dl = document.createElement('a');
  dl.textContent = '⤓ DOWNLOAD JSON';
  dl.style.display = 'inline-block';
  dl.style.color = '#00e5ff';
  dl.style.padding = '4px 8px';
  dl.style.border = '1px solid #00e5ff';
  dl.style.marginTop = '6px';
  dl.style.cursor = 'pointer';
  dl.style.textDecoration = 'none';
  dl.style.fontSize = '0.65rem';
  root.appendChild(dl);

  document.body.appendChild(root);

  const show = (results: BenchOutput[]): void => {
    const json = JSON.stringify(results, null, 2);
    ta.value = json;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    dl.href = url;
    dl.download = `bench-${Date.now()}.json`;
    root.style.display = 'block';
  };

  const hide = (): void => {
    root.style.display = 'none';
  };

  const destroy = (): void => {
    if (dl.href) URL.revokeObjectURL(dl.href);
    root.remove();
  };

  return { show, hide, destroy };
}
