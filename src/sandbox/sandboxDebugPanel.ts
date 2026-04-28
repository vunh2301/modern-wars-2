/**
 * Sandbox debug panel — floating UI replace cho ?seed/?rows/?cols URL params.
 *
 * Components:
 *   - Seed input + Regenerate + Random
 *   - Preset buttons (8 presets từ WORLDGEN_PRESETS)
 *   - Sliders cho 11 key params (collapsible "Advanced" section)
 *   - Stats display (terrain distribution %)
 *
 * Vanilla TS DOM, no framework. Mount append to document.body.
 * Mobile responsive (collapses to hamburger on <720px).
 */
import {
  DEFAULT_WORLDGEN_PARAMS,
  WORLDGEN_PRESETS,
  type WorldgenParams,
} from './sandboxData';

export interface DebugPanelState {
  seed: number;
  params: WorldgenParams;
}

export interface DebugPanelOptions {
  initial: DebugPanelState;
  onRegenerate: (state: DebugPanelState) => void;
}

export function createDebugPanel(opts: DebugPanelOptions): { destroy(): void } {
  const state: DebugPanelState = {
    seed: opts.initial.seed,
    params: { ...opts.initial.params },
  };

  // ─── Inject CSS ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #mw-sandbox-panel {
      position: fixed;
      top: 8px;
      left: 8px;
      width: 280px;
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      background: rgba(15, 18, 28, 0.94);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid #2a3045;
      border-radius: 6px;
      color: #e6e6e6;
      font-family: ui-monospace, 'SF Mono', Consolas, monospace;
      font-size: 12px;
      padding: 8px;
      z-index: 10000;
      transition: transform 0.2s ease;
    }
    #mw-sandbox-panel.collapsed {
      transform: translateX(-110%);
    }
    #mw-sandbox-toggle {
      position: fixed;
      top: 8px; left: 8px;
      width: 36px; height: 36px;
      background: rgba(15, 18, 28, 0.94);
      backdrop-filter: blur(8px);
      border: 1px solid #2a3045;
      border-radius: 6px;
      color: #6cf;
      font-size: 16px;
      cursor: pointer;
      z-index: 10001;
      display: none;
    }
    #mw-sandbox-panel.collapsed ~ #mw-sandbox-toggle {
      display: block;
    }
    #mw-sandbox-panel h3 {
      margin: 0 0 6px 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #6cf;
      border-bottom: 1px solid #2a3045;
      padding-bottom: 4px;
    }
    #mw-sandbox-panel .section {
      margin-top: 8px;
    }
    #mw-sandbox-panel .row {
      display: flex; align-items: center; gap: 6px; margin: 4px 0;
    }
    #mw-sandbox-panel .row label {
      flex: 0 0 100px; color: #aab; font-size: 10px;
    }
    #mw-sandbox-panel .row input[type="range"] {
      flex: 1; accent-color: #6cf; height: 24px;
    }
    #mw-sandbox-panel .row .val {
      flex: 0 0 38px; text-align: right; color: #6cf; font-size: 10px;
    }
    #mw-sandbox-panel input[type="number"] {
      background: #14172a; color: #e6e6e6;
      border: 1px solid #2a3045; padding: 6px;
      border-radius: 3px; font-family: inherit; font-size: 12px;
      width: 100%; min-height: 32px;
    }
    #mw-sandbox-panel button {
      background: #1f3a5f; color: #cfe;
      border: 1px solid #2c5688; padding: 6px 8px;
      border-radius: 3px; cursor: pointer;
      font-family: inherit; font-size: 11px;
      width: 100%; min-height: 32px;
      transition: background 0.12s;
    }
    #mw-sandbox-panel button:hover { background: #2c5688; }
    #mw-sandbox-panel button:active { transform: scale(0.97); }
    #mw-sandbox-panel button.secondary {
      background: #2a2540; border-color: #443866; color: #cbf;
    }
    #mw-sandbox-panel button.preset-btn {
      text-align: left; padding: 4px 8px; font-size: 10px;
      min-height: 28px; margin-bottom: 3px;
    }
    #mw-sandbox-panel button.preset-btn .desc {
      display: block; color: #aab; font-size: 9px; margin-top: 2px;
    }
    #mw-sandbox-panel .close-btn {
      position: absolute; top: 6px; right: 6px;
      background: transparent; border: none;
      color: #aab; font-size: 16px; cursor: pointer;
      width: 24px; height: 24px; min-height: 0;
      padding: 0;
    }
    #mw-sandbox-panel .close-btn:hover { color: #fff; background: transparent; }
    #mw-sandbox-panel .stack > * + * { margin-top: 4px; }
    #mw-sandbox-panel details {
      margin-top: 8px;
    }
    #mw-sandbox-panel details summary {
      cursor: pointer;
      color: #aab; font-size: 10px;
      text-transform: uppercase; letter-spacing: 1px;
      padding: 4px 0;
    }
    #mw-sandbox-panel details[open] summary { color: #6cf; }
    @media (max-width: 720px) {
      #mw-sandbox-panel {
        width: calc(100vw - 16px);
        max-height: calc(100vh - 80px);
      }
    }
  `;
  document.head.appendChild(style);

  // ─── Build panel DOM ───────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'mw-sandbox-panel';

  panel.innerHTML = `
    <h3>Sandbox Worldgen</h3>
    <button class="close-btn" id="mw-panel-close" title="Đóng">×</button>

    <div class="section">
      <div class="row">
        <label>Seed</label>
        <input type="number" id="mw-seed" value="${state.seed}" />
      </div>
      <div class="stack">
        <button id="mw-regenerate">Regenerate</button>
        <button id="mw-random" class="secondary">Random seed</button>
      </div>
    </div>

    <div class="section">
      <h3>Presets</h3>
      <div id="mw-presets"></div>
    </div>

    <details open>
      <summary>Thresholds</summary>
      <div id="mw-thresholds"></div>
    </details>

    <details>
      <summary>Field weights</summary>
      <div id="mw-weights"></div>
    </details>

    <details>
      <summary>Macro cohesion</summary>
      <div id="mw-cohesion"></div>
    </details>

    <details>
      <summary>Noise frequencies</summary>
      <div id="mw-noise"></div>
    </details>
  `;

  document.body.appendChild(panel);

  const toggle = document.createElement('button');
  toggle.id = 'mw-sandbox-toggle';
  toggle.textContent = '≡';
  toggle.title = 'Mở panel';
  document.body.appendChild(toggle);

  // ─── Wire up ──────────────────────────────────────────────────────────────
  const seedInput = panel.querySelector<HTMLInputElement>('#mw-seed')!;
  seedInput.addEventListener('input', () => {
    const v = parseInt(seedInput.value, 10);
    if (!isNaN(v)) state.seed = v;
  });

  const triggerRegen = (): void => {
    opts.onRegenerate({ seed: state.seed, params: { ...state.params } });
  };

  panel.querySelector<HTMLButtonElement>('#mw-regenerate')!.addEventListener('click', triggerRegen);
  panel.querySelector<HTMLButtonElement>('#mw-random')!.addEventListener('click', () => {
    const s = Math.floor(Math.random() * 1e9);
    state.seed = s;
    seedInput.value = String(s);
    triggerRegen();
  });

  panel.querySelector<HTMLButtonElement>('#mw-panel-close')!.addEventListener('click', () => {
    panel.classList.add('collapsed');
  });
  toggle.addEventListener('click', () => {
    panel.classList.remove('collapsed');
  });

  // Preset buttons.
  const presetsDiv = panel.querySelector<HTMLDivElement>('#mw-presets')!;
  for (const [key, preset] of Object.entries(WORLDGEN_PRESETS)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn secondary';
    btn.innerHTML = `<strong>${preset.name}</strong><span class="desc">${preset.description}</span>`;
    btn.addEventListener('click', () => {
      // Reset to defaults + apply preset overrides.
      state.params = { ...DEFAULT_WORLDGEN_PARAMS, ...preset.params };
      syncSlidersFromState();
      triggerRegen();
    });
    presetsDiv.appendChild(btn);
    void key;
  }

  // ─── Slider builder ───────────────────────────────────────────────────────
  interface SliderSpec {
    key: keyof WorldgenParams;
    label: string;
    min: number;
    max: number;
    step: number;
    decimals: number;
  }

  const buildSlider = (parent: HTMLDivElement, spec: SliderSpec): void => {
    const row = document.createElement('div');
    row.className = 'row';
    const cur = state.params[spec.key] as number;
    row.innerHTML = `
      <label>${spec.label}</label>
      <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${cur}" data-key="${spec.key}" />
      <span class="val">${cur.toFixed(spec.decimals)}</span>
    `;
    parent.appendChild(row);
    const input = row.querySelector<HTMLInputElement>('input')!;
    const valSpan = row.querySelector<HTMLSpanElement>('.val')!;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      (state.params as unknown as Record<string, number>)[spec.key] = v;
      valSpan.textContent = v.toFixed(spec.decimals);
      triggerRegen();
    });
  };

  const thresholdsDiv = panel.querySelector<HTMLDivElement>('#mw-thresholds')!;
  buildSlider(thresholdsDiv, { key: 'seaLevel', label: 'Sea level', min: 0.20, max: 0.65, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'coastBand', label: 'Coast band', min: 0.01, max: 0.15, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'mountainLevel', label: 'Mountain', min: 0.50, max: 0.90, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'hillBand', label: 'Hill band', min: 0.04, max: 0.30, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'forestMoisture', label: 'Forest moist', min: 0.30, max: 0.80, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'desertMoisture', label: 'Desert moist', min: 0.10, max: 0.50, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'desertTemperature', label: 'Desert temp', min: 0.30, max: 0.90, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'swampMoisture', label: 'Swamp moist', min: 0.50, max: 0.95, step: 0.01, decimals: 2 });
  buildSlider(thresholdsDiv, { key: 'urbanProbability', label: 'Urban prob', min: 0, max: 0.05, step: 0.001, decimals: 3 });

  const weightsDiv = panel.querySelector<HTMLDivElement>('#mw-weights')!;
  buildSlider(weightsDiv, { key: 'radialFalloffWeight', label: 'Radial bias', min: 0, max: 0.6, step: 0.01, decimals: 2 });
  buildSlider(weightsDiv, { key: 'elevNoiseWeight', label: 'Elev noise wt', min: 0.4, max: 1.0, step: 0.01, decimals: 2 });
  buildSlider(weightsDiv, { key: 'elevFalloffPower', label: 'Falloff pwr', min: 0.5, max: 4.0, step: 0.1, decimals: 1 });
  buildSlider(weightsDiv, { key: 'elevCurvePower', label: 'Elev curve', min: 0.5, max: 1.5, step: 0.05, decimals: 2 });
  buildSlider(weightsDiv, { key: 'moistureBias', label: 'Moist bias', min: -0.4, max: 0.4, step: 0.01, decimals: 2 });
  buildSlider(weightsDiv, { key: 'temperatureLatitudeWeight', label: 'Temp lat wt', min: 0, max: 1.0, step: 0.05, decimals: 2 });

  const cohesionDiv = panel.querySelector<HTMLDivElement>('#mw-cohesion')!;
  buildSlider(cohesionDiv, { key: 'smoothingPasses', label: 'Smooth pass', min: 0, max: 10, step: 1, decimals: 0 });
  buildSlider(cohesionDiv, { key: 'oceanFillNeighbors', label: 'Ocean fill≥', min: 3, max: 6, step: 1, decimals: 0 });
  buildSlider(cohesionDiv, { key: 'elevBlurPasses', label: 'Elev blur', min: 0, max: 6, step: 1, decimals: 0 });
  buildSlider(cohesionDiv, { key: 'moistureBlurPasses', label: 'Moist blur', min: 0, max: 6, step: 1, decimals: 0 });
  buildSlider(cohesionDiv, { key: 'minComponentSize', label: 'Min cluster', min: 0, max: 30, step: 1, decimals: 0 });

  const noiseDiv = panel.querySelector<HTMLDivElement>('#mw-noise')!;
  buildSlider(noiseDiv, { key: 'elevationFreq', label: 'Elev freq', min: 0.5, max: 6.0, step: 0.1, decimals: 1 });
  buildSlider(noiseDiv, { key: 'elevationOctaves', label: 'Elev octaves', min: 2, max: 7, step: 1, decimals: 0 });
  buildSlider(noiseDiv, { key: 'moistureFreq', label: 'Moist freq', min: 0.5, max: 6.0, step: 0.1, decimals: 1 });
  buildSlider(noiseDiv, { key: 'moistureOctaves', label: 'Moist oct', min: 2, max: 6, step: 1, decimals: 0 });

  // Re-sync sliders from state (after preset apply).
  function syncSlidersFromState(): void {
    panel.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
      const key = input.dataset.key as keyof WorldgenParams;
      const v = state.params[key] as number;
      input.value = String(v);
      const valSpan = input.parentElement!.querySelector<HTMLSpanElement>('.val')!;
      const decimals = input.step.includes('.') ? input.step.split('.')[1]!.length : 0;
      valSpan.textContent = v.toFixed(decimals);
    });
  }

  // Auto-collapse on mobile.
  if (window.innerWidth < 720) {
    panel.classList.add('collapsed');
  }

  return {
    destroy(): void {
      panel.remove();
      toggle.remove();
      style.remove();
    },
  };
}
