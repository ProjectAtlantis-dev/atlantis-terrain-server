export function createTerrainTuningControls({
  body,
  state,
  save,
  documentImpl = globalThis.document,
} = {}) {
  const definitions = [];

  function section(text) {
    const element = documentImpl.createElement('div');
    element.style.cssText = 'margin:10px 0 4px;font-size:10px;text-transform:uppercase;color:#6889a8;letter-spacing:1px;border-bottom:1px solid #334;padding-bottom:3px';
    element.textContent = text;
    body.appendChild(element);
    return element;
  }

  function slider(label, options) {
    const saved = state[label];
    const initial = saved != null ? saved : options.value;
    // Keep state as a complete snapshot of the registered controls, rather
    // than a sparse collection whose shape depends on which widgets happened
    // to receive input. The caller persists once after registration finishes.
    if (saved == null) state[label] = Number(initial);
    const row = documentImpl.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:5px 0';
    const labelElement = documentImpl.createElement('span');
    labelElement.style.cssText = 'flex:0 0 90px;font-size:11px;color:#9ab';
    labelElement.textContent = label;
    const input = documentImpl.createElement('input');
    input.type = 'range';
    input.min = options.min;
    input.max = options.max;
    input.step = options.step;
    input.value = initial;
    input.style.cssText = 'flex:1;accent-color:#5af';
    const valueElement = documentImpl.createElement('span');
    valueElement.style.cssText = 'flex:0 0 40px;text-align:right;font-size:11px;color:#7cf';
    const format = options.format || (value => value.toFixed(options.decimals ?? 2));
    valueElement.textContent = format(Number(initial));
    if (saved != null) options.onChange(Number(saved));
    input.oninput = () => {
      const value = Number(input.value);
      valueElement.textContent = format(value);
      state[label] = value;
      save();
      options.onChange(value);
    };
    row.append(labelElement, input, valueElement);
    body.appendChild(row);
    definitions.push({
      label, defaultValue: options.value, input, valueElement, format,
      onChange: options.onChange, type: 'slider',
    });
    return input;
  }

  function toggle(label, options) {
    const saved = state[label];
    const initial = saved != null ? saved : options.value;
    if (saved == null) state[label] = Boolean(initial);
    const row = documentImpl.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:5px 0';
    const labelElement = documentImpl.createElement('span');
    labelElement.style.cssText = 'flex:0 0 90px;font-size:11px;color:#9ab';
    labelElement.textContent = label;
    const input = documentImpl.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.style.cssText = 'accent-color:#5af';
    if (saved != null) options.onChange(initial);
    input.onchange = () => {
      state[label] = input.checked;
      save();
      options.onChange(input.checked);
    };
    row.append(labelElement, input);
    body.appendChild(row);
    definitions.push({
      label, defaultValue: options.value, input,
      onChange: options.onChange, type: 'toggle',
    });
    return input;
  }

  function reset() {
    for (const definition of definitions) {
      if (definition.type === 'slider') {
        definition.input.value = definition.defaultValue;
        definition.valueElement.textContent = definition.format(definition.defaultValue);
      } else {
        definition.input.checked = definition.defaultValue;
      }
      definition.onChange(definition.defaultValue);
    }
  }

  function setSliderValue(label, value) {
    const definition = definitions.find(item => item.label === label && item.type === 'slider');
    if (!definition) return;
    definition.input.value = value;
    definition.valueElement.textContent = definition.format(value);
  }

  return { reset, section, setSliderValue, slider, toggle };
}
