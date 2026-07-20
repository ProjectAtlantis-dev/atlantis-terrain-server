import { createTerrainGridlinesController } from './terrain-gridlines.js';

export function createTerrainGridlinesRuntime({
  terrainRoot,
  onChanged = () => {},
}) {
  const grid = createTerrainGridlinesController({ terrainRoot });
  let active = false;

  function update() {
    if (active && grid.update()) onChanged();
  }

  function setActive(enabled) {
    active = Boolean(enabled);
    grid.setVisible(active);
    onChanged();
    return active;
  }

  function toggle() {
    return setActive(!active);
  }

  return {
    grid,
    update,
    setActive,
    toggle,
    get active() { return active; },
  };
}
