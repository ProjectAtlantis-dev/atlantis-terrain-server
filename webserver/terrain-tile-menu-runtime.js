const DEFAULT_POSITIVE = 'sharpen details on this satellite photo of some mountaineous terrain, high resolution aerial orthophoto';
const DEFAULT_NEGATIVE = 'bad quality, blurry, messy, lowres, artifacts, flat, oversaturated, boring, trees, haze';

export function createTerrainTileMenuRuntime({
  controls,
  tileInfoElement,
  terrainTiles,
  enhancementController,
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
  storage = globalThis.localStorage,
  fetchImpl = (...args) => fetch(...args),
  consoleImpl = globalThis.console,
} = {}) {
  const menu = documentImpl.createElement('div');
  menu.style.cssText = [
    'position:absolute', 'display:none', 'z-index:20',
    'background:rgba(0,0,0,0.9)', 'border:1px solid #555', 'border-radius:6px',
    'padding:4px 0', 'min-width:180px',
    'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'color:#fff', 'cursor:default',
  ].join(';');
  documentImpl.body.appendChild(menu);

  let dialog = documentImpl.getElementById('enhance-dialog');
  if (!dialog) {
    dialog = documentImpl.createElement('div');
    dialog.id = 'enhance-dialog';
    dialog.style.cssText = [
      'position:fixed', 'display:none', 'z-index:30',
      'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'background:rgba(0,0,0,0.95)', 'border:1px solid #555', 'border-radius:8px',
      'padding:16px', 'min-width:400px',
      'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', 'color:#fff',
    ].join(';');
    documentImpl.body.appendChild(dialog);
  }

  function hide() {
    menu.style.display = 'none';
    tileInfoElement.style.display = 'none';
  }

  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-action="enhance-submit"]');
    if (!button) return;
    const positive = dialog.querySelector('[data-role="pos-prompt"]');
    const negative = dialog.querySelector('[data-role="neg-prompt"]');
    if (!button.dataset.tileId || !positive || !negative) return;
    dialog.style.display = 'none';
    storage.setItem('enhance_positive_prompt', positive.value);
    storage.setItem('enhance_negative_prompt', negative.value);
    enhancementController.submit(button.dataset.tileId, {
      positive_prompt: positive.value,
      negative_prompt: negative.value,
    });
  });

  function showEnhance(tileId) {
    dialog.innerHTML = '';
    const title = documentImpl.createElement('div');
    title.style.cssText = 'font-size:14px;font-weight:bold;margin-bottom:12px';
    title.textContent = `Enhance ${tileId}`;
    dialog.appendChild(title);
    const makeLabel = text => {
      const label = documentImpl.createElement('div');
      label.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:4px';
      label.textContent = text;
      return label;
    };
    const makeTextarea = value => {
      const textarea = documentImpl.createElement('textarea');
      textarea.style.cssText = 'width:100%;height:60px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:4px;padding:6px;font:12px/1.4 inherit;resize:vertical;box-sizing:border-box;margin-bottom:10px';
      textarea.value = value;
      return textarea;
    };
    dialog.appendChild(makeLabel('Positive prompt'));
    const positive = makeTextarea(storage.getItem('enhance_positive_prompt') ?? DEFAULT_POSITIVE);
    positive.dataset.role = 'pos-prompt';
    dialog.appendChild(positive);
    dialog.appendChild(makeLabel('Negative prompt'));
    const negative = makeTextarea(storage.getItem('enhance_negative_prompt') ?? DEFAULT_NEGATIVE);
    negative.dataset.role = 'neg-prompt';
    dialog.appendChild(negative);
    const buttons = documentImpl.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';
    const cancel = documentImpl.createElement('button');
    cancel.style.cssText = 'padding:6px 14px;background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font:inherit';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { dialog.style.display = 'none'; });
    const submit = documentImpl.createElement('button');
    submit.style.cssText = 'padding:6px 14px;background:#2a6;color:#fff;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:bold';
    submit.textContent = 'Enhance';
    submit.dataset.action = 'enhance-submit';
    submit.dataset.tileId = tileId;
    buttons.append(cancel, submit);
    dialog.appendChild(buttons);
    dialog.style.display = 'block';
    for (const key of Object.keys(controls.keys)) controls.keys[key] = false;
    positive.focus();
  }

  function addAction(label, action) {
    const element = documentImpl.createElement('div');
    element.style.cssText = 'padding:6px 12px;cursor:pointer';
    element.textContent = label;
    element.addEventListener('mouseenter', () => { element.style.background = 'rgba(255,255,255,0.15)'; });
    element.addEventListener('mouseleave', () => { element.style.background = 'none'; });
    element.addEventListener('click', action);
    menu.appendChild(element);
    return element;
  }

  function discard(tileId) {
    hide();
    fetchImpl(`/api/texture/${tileId}/discard_enhanced`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        if (!data.ok) {
          consoleImpl.warn(`[DISCARD] ${tileId}:`, data.error);
          return;
        }
        terrainTiles.discardEnhancedTexture(tileId);
      })
      .catch(error => consoleImpl.error(`[DISCARD] ${tileId}:`, error));
  }

  function show(x, y, tileId, source) {
    menu.innerHTML = '';
    const header = documentImpl.createElement('div');
    header.style.cssText = 'padding:4px 12px;color:#aaa;font-size:11px;border-bottom:1px solid #444';
    header.textContent = tileId;
    menu.appendChild(header);
    addAction('Tile inspector', () => {
      hide();
      windowImpl.open(`/pipeline.html?tile=${tileId}`, '_blank');
    });
    const enhanced = Boolean(source && (source.includes('enhanced') || source === 'upscaled'));
    if (enhanced) {
      addAction('Discard', () => discard(tileId));
    } else if (source === 'sentinel2' || source === 'dataforsyningen') {
      addAction('Enhance', () => { hide(); showEnhance(tileId); });
    } else if (!source) {
      const note = documentImpl.createElement('div');
      note.style.cssText = 'padding:6px 12px;color:#888;font-style:italic';
      note.textContent = 'no texture';
      menu.appendChild(note);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';
  }

  documentImpl.addEventListener('click', event => { if (!menu.contains(event.target)) hide(); });
  documentImpl.addEventListener('mousedown', event => {
    if (dialog.style.display !== 'none' && !dialog.contains(event.target)) dialog.style.display = 'none';
  });
  return { dialog, hide, menu, show, showEnhance };
}
