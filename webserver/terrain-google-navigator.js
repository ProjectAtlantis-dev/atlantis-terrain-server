const COORDINATE_TOKEN = /([+-]?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?/g;

export function parseGoogleNavigationCoordinates(value) {
  const tokens = [...String(value ?? '').matchAll(COORDINATE_TOKEN)];
  if (tokens.length < 2) return null;
  let lat = Number(tokens[0][1]);
  let lon = Number(tokens[1][1]);
  const latDirection = (tokens[0][2] ?? '').toUpperCase();
  const lonDirection = (tokens[1][2] ?? '').toUpperCase();
  if (latDirection === 'S') lat = -Math.abs(lat);
  if (latDirection === 'N') lat = Math.abs(lat);
  if (lonDirection === 'W') lon = -Math.abs(lon);
  if (lonDirection === 'E') lon = Math.abs(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function mapUrl(tab, lat, lon) {
  return `/mapview.html?lat=${lat}&lon=${lon}&t=${tab === 1 ? 'm' : 'k'}`;
}

function style(element, cssText) {
  element.style.cssText = cssText;
  return element;
}

function headerButton(documentRef, text, title) {
  const element = documentRef.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.title = title;
  element.style.cssText = 'background:none;border:none;color:#8aa;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:1px 5px';
  return element;
}

export function createGoogleNavigator({
  getCameraLatLon,
  navigateTo,
  openGoogle3d = () => {},
  onChanged = () => {},
  documentRef = document,
  windowRef = window,
  updateIntervalMs = 1500,
}) {
  let open = false;
  let minimized = false;
  let activeTab = 0;
  let lastLat = null;
  let lastLon = null;
  let selectedCoordinates = null;
  let updateTimer = null;
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const panel = style(documentRef.createElement('div'), [
    'position:absolute', 'bottom:50px', 'left:12px', 'width:420px', 'height:460px',
    'background:rgba(10,16,24,0.95)', 'border:1px solid #2a3a4a', 'border-radius:8px',
    'overflow:hidden', 'resize:both', 'min-width:300px', 'min-height:200px', 'z-index:20',
    'display:none', 'flex-direction:column',
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', 'color:#dbe5f1',
    'box-shadow:0 4px 24px rgba(0,0,0,0.7)',
  ].join(';'));
  panel.dataset.terrainGoogleNavigator = 'true';

  const header = style(documentRef.createElement('div'),
    'display:flex;align-items:center;gap:6px;padding:7px 10px;background:rgba(255,255,255,0.06);cursor:grab;user-select:none');
  const title = documentRef.createElement('span');
  title.style.cssText = 'flex:1;font-weight:bold;color:#5af';
  title.textContent = '🗺 Maps · Navigate';
  const open3dButton = headerButton(documentRef, '3D', 'Open the current camera in Google Maps 3D');
  const minimizeButton = headerButton(documentRef, '−', 'Minimize');
  const closeButton = headerButton(documentRef, '×', 'Close (G)');
  header.append(title, open3dButton, minimizeButton, closeButton);
  panel.appendChild(header);

  const navRow = style(documentRef.createElement('div'),
    'display:flex;gap:6px;padding:7px 10px;border-bottom:1px solid #1e2d3a');
  const input = documentRef.createElement('input');
  input.type = 'text';
  input.placeholder = 'Paste lat, lon  e.g. 64.18, -51.70';
  input.setAttribute('aria-label', 'Navigation latitude and longitude');
  input.style.cssText = 'flex:1;background:rgba(255,255,255,0.07);border:1px solid #2a3a4a;border-radius:4px;color:#dbe5f1;padding:4px 8px;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none';
  const goButton = documentRef.createElement('button');
  goButton.type = 'button';
  goButton.textContent = 'Navigate';
  goButton.title = 'Move to the entered or map-selected point';
  goButton.style.cssText = 'background:#1a3a5a;border:1px solid #2a5a8a;border-radius:4px;color:#5af;padding:4px 12px;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  navRow.append(input, goButton);
  panel.appendChild(navRow);

  const tabRow = style(documentRef.createElement('div'),
    'display:flex;border-bottom:1px solid #1e2d3a;user-select:none');
  const tabs = ['Satellite', 'Map'].map((label, index) => {
    const tab = documentRef.createElement('button');
    tab.type = 'button';
    tab.textContent = label;
    tab.style.cssText = 'flex:1;text-align:center;padding:5px 0;cursor:pointer;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:none;border:0;border-bottom:2px solid transparent;color:#6889a8';
    tab.addEventListener('click', () => selectTab(index));
    tabRow.appendChild(tab);
    return tab;
  });
  panel.appendChild(tabRow);

  const iframeWrap = style(documentRef.createElement('div'), 'flex:1;min-height:0');
  const iframe = documentRef.createElement('iframe');
  iframe.title = 'Terrain navigation map';
  iframe.loading = 'eager';
  iframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
  iframeWrap.appendChild(iframe);
  panel.appendChild(iframeWrap);
  documentRef.body.appendChild(panel);

  function updateTabStyles() {
    tabs.forEach((tab, index) => {
      const selected = index === activeTab;
      tab.style.color = selected ? '#5af' : '#6889a8';
      tab.style.borderBottomColor = selected ? '#5af' : 'transparent';
    });
  }

  function forceUpdate() {
    if (!open) return;
    const position = getCameraLatLon();
    if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lon)) return;
    lastLat = position.lat.toFixed(6);
    lastLon = position.lon.toFixed(6);
    iframe.src = mapUrl(activeTab, lastLat, lastLon);
  }

  function updateIfMoved() {
    if (!open || minimized) return;
    const position = getCameraLatLon();
    if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lon)) return;
    const lat = position.lat.toFixed(6);
    const lon = position.lon.toFixed(6);
    if (lat === lastLat && lon === lastLon) return;
    iframe.contentWindow?.postMessage({
      lat: position.lat,
      lon: position.lon,
      follow: selectedCoordinates == null,
    }, '*');
    lastLat = lat;
    lastLon = lon;
  }

  function selectTab(index) {
    activeTab = Math.max(0, Math.min(1, Number(index) || 0));
    lastLat = null;
    lastLon = null;
    updateTabStyles();
    forceUpdate();
  }

  function setOpen(next) {
    open = Boolean(next);
    panel.style.display = open ? 'flex' : 'none';
    if (updateTimer != null) windowRef.clearInterval(updateTimer);
    updateTimer = null;
    if (open) {
      lastLat = null;
      lastLon = null;
      forceUpdate();
      updateTimer = windowRef.setInterval(updateIfMoved, updateIntervalMs);
    }
    onChanged();
    return open;
  }

  function toggle(forceState) {
    return setOpen(forceState === undefined ? !open : forceState);
  }

  function submit() {
    const coordinates = parseGoogleNavigationCoordinates(input.value);
    if (!coordinates) {
      input.setCustomValidity('Enter a valid latitude and longitude.');
      input.reportValidity?.();
      return false;
    }
    input.setCustomValidity('');
    selectedCoordinates = coordinates;
    const navigated = navigateTo(coordinates.lat, coordinates.lon);
    if (navigated === false) return false;
    selectedCoordinates = null;
    lastLat = null;
    lastLon = null;
    windowRef.setTimeout(forceUpdate, 0);
    return true;
  }

  goButton.addEventListener('click', submit);
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') submit();
  });
  open3dButton.addEventListener('click', event => { event.stopPropagation(); openGoogle3d(); });
  minimizeButton.addEventListener('click', event => {
    event.stopPropagation();
    minimized = !minimized;
    navRow.style.display = minimized ? 'none' : '';
    tabRow.style.display = minimized ? 'none' : '';
    iframeWrap.style.display = minimized ? 'none' : '';
    minimizeButton.textContent = minimized ? '□' : '−';
    onChanged();
  });
  closeButton.addEventListener('click', event => { event.stopPropagation(); setOpen(false); });

  header.addEventListener('mousedown', event => {
    if (event.target !== header && event.target !== title) return;
    const rect = panel.getBoundingClientRect();
    dragging = true;
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    event.preventDefault();
  });
  const onMouseMove = event => {
    if (!dragging) return;
    panel.style.left = `${event.clientX - dragOffsetX}px`;
    panel.style.top = `${event.clientY - dragOffsetY}px`;
    panel.style.bottom = 'auto';
  };
  const onMouseUp = () => { dragging = false; };
  windowRef.addEventListener('mousemove', onMouseMove);
  windowRef.addEventListener('mouseup', onMouseUp);

  const onMessage = event => {
    if (event.source !== iframe.contentWindow || !event.data) return;
    if (event.data.ready && open) {
      const position = getCameraLatLon();
      iframe.contentWindow?.postMessage({
        lat: position.lat,
        lon: position.lon,
        follow: selectedCoordinates == null,
        selected: selectedCoordinates,
      }, '*');
    } else if (event.data.select) {
      const lat = Number(event.data.lat);
      const lon = Number(event.data.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)
          && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        selectedCoordinates = { lat, lon };
        input.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        input.setCustomValidity('');
        goButton.focus();
      }
    }
  };
  windowRef.addEventListener('message', onMessage);

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      iframe.style.pointerEvents = 'none';
      windowRef.clearTimeout(panel._resizeTimer);
      panel._resizeTimer = windowRef.setTimeout(() => { iframe.style.pointerEvents = ''; }, 150);
    });
    resizeObserver.observe(panel);
  }

  updateTabStyles();
  return {
    panel, input, iframe, toggle, submit,
    navigate: (lat, lon) => navigateTo(lat, lon),
    select(lat, lon) {
      selectedCoordinates = { lat, lon };
      input.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      iframe.contentWindow?.postMessage({ selected: selectedCoordinates }, '*');
    },
    get selectedCoordinates() { return selectedCoordinates && { ...selectedCoordinates }; },
    get isOpen() { return open; },
    get activeTab() { return activeTab; },
    destroy() {
      if (updateTimer != null) windowRef.clearInterval(updateTimer);
      resizeObserver?.disconnect();
      windowRef.removeEventListener('mousemove', onMouseMove);
      windowRef.removeEventListener('mouseup', onMouseUp);
      windowRef.removeEventListener('message', onMessage);
      panel.remove();
    },
  };
}
