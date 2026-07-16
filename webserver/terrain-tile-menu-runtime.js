export function createTerrainTileMenuRuntime({
  tileInfoElement,
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
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

  function hide() {
    menu.style.display = 'none';
    tileInfoElement.style.display = 'none';
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
    if (!source) {
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
  return { hide, menu, show };
}
