/**
 * ArcticFlora — real-data species roster driving realistic scatter placement.
 *
 * Pure data (no TSL / three imports) so it drops into either working copy and
 * feeds the understory composition in Scatter.ts. Grounded in the stored
 * Greenland flora research (base rates per km², density formulas, palettes).
 * The runtime data below is self-contained and has no private-path dependency.
 *
 * `abundance` is the research "base rate per km²" normalised (÷6000, showy
 * drift-formers floored for visibility). It scales COMPOSITION only — the
 * biome-density accept gate in Scatter decides COVER, so a rare species is rare
 * but the vegetation layer is never thinned. Real Greenland reads as an autumn
 * heath MOSAIC (crimson bilberry / scarlet bearberry / orange birch / rust
 * crowberry) with sparse flowers concentrated into DRIFTS, not carpets — so
 * showy forbs get low abundance but high colony contrast (punchy patches).
 *
 * Season: `summer`→`autumn` foliage is lerped by the engine AUTUMN dial; `bloom`
 * gives the flowering window (spring/early-summer). Winter = snow cover hides
 * low plants. Full four-season states extend from these.
 *
 * Biome zone columns (match BiomeSnow.ts / Scatter byBiome tables):
 *   [0]=Nival  [1]=FellField  [2]=DwarfShrubTundra  [3]=ShrubHeath  [4]=Meadow  [5]=Mire
 */

export type BiomeWeights = readonly [
  nival: number,
  fell: number,
  tundra: number,
  heath: number,
  meadow: number,
  mire: number,
];

/** growth form → drives archetype mesh + colony behaviour + wind flexibility */
export type GrowthForm =
  | 'cushion' //   tight dome, cm-scale (Silene, some Saxifraga)
  | 'prostrate-mat' // creeping woody/leafy mat (Dryas, Salix arctica)
  | 'dwarf-shrub' //  knee-high woody (Betula nana, Vaccinium, Ledum)
  | 'erect-forb' //   upright herb w/ showy bloom (poppy, fireweed, roseroot)
  | 'rosette-forb' //  basal rosette + short scape (avens umbels, scurvygrass)
  | 'graminoid' //    grass / sedge / cottongrass tussock
  | 'horsetail' //    jointed clonal stems (Equisetum)
  | 'fern'; //        frond rosette

export interface FloraSpecies {
  id: string;
  scientific: string;
  common: string;
  /** engine VegClass id this species renders as (-1 = not yet a class/variant) */
  cls: number;
  /** variant range [lo,hi] within the class to draw from (default [0,3]). Use a
   *  fixed slot ([2,2]) to place a variant-packed species in its own mesh slot —
   *  the composition then weights it by ITS habitat, not a blind uniform split. */
  variant?: readonly [number, number];
  form: GrowthForm;
  /** research base rate per km² ÷ 6000 (showy drift-formers floored for view). */
  abundance: number;
  /** relative habitat affinity in each Arctic zone (0..1, unnormalised) */
  biome: BiomeWeights;
  /** moisture niche [dryEdge, optimum, wetEdge] on the 0..1 field */
  moisture: readonly [number, number, number];
  /** snow tolerance: max snow-field value before the plant fades out (0..1) */
  snowTol: number;
  /** steepest slope it holds (0..1 field) */
  maxSlope: number;
  /** −1 avoids rock … 0 neutral … +1 chasmophyte / bare-gravel specialist */
  rockAffinity: number;
  /** 0 dry divide … 1 streamside / flushed-channel specialist */
  flowAffinity: number;
  /** characteristic colony / clone diameter in metres (patch clumping) */
  colonyM: number;
  /** summer foliage tint (linear-ish rgb, matches VegMaterials leaf inputs) */
  summer: readonly [number, number, number];
  /** autumn foliage tint — lerped by the AUTUMN season dial (the mood driver) */
  autumn: readonly [number, number, number];
  /** flower/bloom colour (petals); null = inconspicuous */
  flower: readonly [number, number, number] | null;
  /** bloom window [startMonth, endMonth], 6=Jun … 9=Sep */
  bloom: readonly [number, number];
  note: string;
}

/**
 * Core roster — the 16 species meshed in this project. abundance ≈ research base
 * rate ÷6000: crowberry 12k→2.0, avens 9k→1.5, cushion 6k→1.0, labrador tea
 * 5k→0.83, birch 4.5k→0.75, willow 4k→0.67, saxifrage 3k→0.5, poppy 800→0.13.
 * niviarsiaq (not in the atlantis catalog — Greenland's national flower, a showy
 * drift-former) and harebell/roseroot get a viewer-floored estimate.
 */
export const GREENLAND_FLORA: readonly FloraSpecies[] = [
  // ---- dwarf shrubs — the heath matrix + the autumn colour mosaic -----------
  {
    id: 'dwarfBirch', scientific: 'Betula nana', common: 'Dwarf birch', cls: 8,
    form: 'dwarf-shrub', abundance: 0.75,
    biome: [0, 0.02, 0.2, 0.46, 0.08, 0.05],
    moisture: [0.2, 0.5, 0.85], snowTol: 0.55, maxSlope: 0.6,
    rockAffinity: -0.2, flowAffinity: 0.15, colonyM: 9,
    summer: [0.05, 0.105, 0.035], autumn: [0.55, 0.24, 0.03], flower: null,
    bloom: [6, 7],
    note: 'peaks in sheltered heath; blazes orange-red in autumn (mood driver)',
  },
  {
    id: 'crowberry', scientific: 'Empetrum nigrum', common: 'Crowberry',
    cls: 10, variant: [0, 1], form: 'dwarf-shrub', abundance: 2.0,
    biome: [0.02, 0.32, 0.58, 0.46, 0.12, 0.08],
    moisture: [0.05, 0.36, 0.78], snowTol: 0.6, maxSlope: 0.72,
    rockAffinity: 0.1, flowAffinity: 0.05, colonyM: 6,
    summer: [0.03, 0.062, 0.035], autumn: [0.15, 0.055, 0.035], flower: null,
    bloom: [6, 6],
    note: 'dominant Arctic dwarf shrub (base rate 12k); rust-red autumn mats',
  },
  // Bilberry & bearberry share the crowberry class via packed variant slots
  // (v3, v2 — see VegLibrary), but are SEPARATE roster entries so each is
  // weighted by its OWN habitat and adds density instead of stealing crowberry's.
  {
    id: 'bogBilberry', scientific: 'Vaccinium uliginosum', common: 'Bog bilberry',
    cls: 10, variant: [3, 3], form: 'dwarf-shrub', abundance: 1.5,
    biome: [0, 0.04, 0.34, 0.5, 0.16, 0.12],
    moisture: [0.32, 0.58, 0.9], snowTol: 0.55, maxSlope: 0.5,
    rockAffinity: -0.25, flowAffinity: 0.25, colonyM: 6.5,
    summer: [0.06, 0.125, 0.08], autumn: [0.42, 0.04, 0.05], flower: null,
    bloom: [6, 7],
    note: 'base rate 10k; MOIST dwarf-shrub heath; crimson autumn (mood driver)',
  },
  {
    id: 'bearberry', scientific: 'Arctous alpina', common: 'Alpine bearberry',
    cls: 10, variant: [2, 2], form: 'prostrate-mat', abundance: 1.3,
    biome: [0.02, 0.28, 0.42, 0.24, 0.1, 0.02],
    moisture: [0.08, 0.32, 0.62], snowTol: 0.48, maxSlope: 0.7,
    rockAffinity: 0.3, flowAffinity: 0.0, colonyM: 5,
    summer: [0.075, 0.145, 0.06], autumn: [0.5, 0.06, 0.02], flower: null,
    bloom: [6, 7],
    note: 'base rate 8k; DRY well-drained fell/tundra; scarlet autumn',
  },
  {
    id: 'labradorTea', scientific: 'Rhododendron groenlandicum',
    common: 'Labrador tea', cls: 27, variant: [0, 1], form: 'dwarf-shrub',
    abundance: 0.83,
    biome: [0, 0.02, 0.1, 0.3, 0.12, 0.34],
    moisture: [0.45, 0.75, 1.05], snowTol: 0.5, maxSlope: 0.46,
    rockAffinity: -0.3, flowAffinity: 0.4, colonyM: 7.5,
    summer: [0.035, 0.095, 0.035], autumn: [0.05, 0.08, 0.04],
    flower: [0.91, 0.9, 0.84], bloom: [6, 7],
    note: 'evergreen bog subshrub; snow-bed & wet-heath margins; white heads',
  },
  {
    id: 'cassiope', scientific: 'Cassiope tetragona',
    common: 'Arctic bell-heather', cls: 27, variant: [2, 3], form: 'dwarf-shrub',
    abundance: 1.2,
    biome: [0.02, 0.16, 0.24, 0.32, 0.1, 0.14],
    moisture: [0.28, 0.55, 0.9], snowTol: 0.78, maxSlope: 0.55,
    rockAffinity: 0.0, flowAffinity: 0.2, colonyM: 5,
    summer: [0.03, 0.075, 0.035], autumn: [0.06, 0.08, 0.045],
    flower: [0.93, 0.92, 0.9], bloom: [6, 7],
    note: 'base rate 8k; snow-bed heath (high snowTol); nodding white bells',
  },

  // ---- prostrate mats (CAVM prostrate-shrub tundra, Dryas + Salix) ----------
  {
    id: 'mountainAvens', scientific: 'Dryas integrifolia',
    common: 'Mountain avens', cls: 25, form: 'prostrate-mat', abundance: 1.5,
    biome: [0.05, 0.4, 0.24, 0.14, 0.12, 0.06],
    moisture: [0.03, 0.3, 0.66], snowTol: 0.46, maxSlope: 0.8,
    rockAffinity: 0.5, flowAffinity: 0.05, colonyM: 4,
    summer: [0.075, 0.13, 0.045], autumn: [0.1, 0.11, 0.05],
    flower: [0.9, 0.89, 0.82], bloom: [6, 7],
    note: 'calcareous/gravel fell mat (base rate 9k); white 8-petal, yellow eye',
  },
  {
    id: 'arcticWillow', scientific: 'Salix arctica', common: 'Arctic willow',
    cls: 26, variant: [0, 1], form: 'prostrate-mat', abundance: 0.67,
    biome: [0.01, 0.18, 0.4, 0.3, 0.22, 0.16],
    moisture: [0.18, 0.56, 0.92], snowTol: 0.62, maxSlope: 0.68,
    rockAffinity: 0.1, flowAffinity: 0.3, colonyM: 6.5,
    summer: [0.075, 0.15, 0.055], autumn: [0.5, 0.34, 0.06],
    flower: [0.72, 0.56, 0.12], bloom: [6, 7],
    note: 'ground-hugging tundra willow; upright catkins; wide moisture range',
  },
  {
    id: 'deadWillow', scientific: 'Salix arctica (dead)',
    common: 'Standing dead willow', cls: 26, variant: [2, 3],
    form: 'prostrate-mat', abundance: 0.28,
    biome: [0.01, 0.16, 0.36, 0.28, 0.2, 0.15],
    moisture: [0.18, 0.56, 0.92], snowTol: 0.62, maxSlope: 0.68,
    rockAffinity: 0.1, flowAffinity: 0.3, colonyM: 6.5,
    summer: [0.33, 0.31, 0.27], autumn: [0.33, 0.31, 0.27], flower: null,
    bloom: [6, 6],
    note: 'bleached leafless willow skeleton; co-scatters with live willow, all year',
  },

  // ---- cushions & rosettes (fell-field gravel, frost-boils) ----------------
  {
    id: 'mossCampion', scientific: 'Silene acaulis', common: 'Moss campion',
    cls: 24, form: 'cushion', abundance: 1.0,
    biome: [0.06, 0.4, 0.16, 0.1, 0.14, 0.02],
    moisture: [0.01, 0.24, 0.6], snowTol: 0.42, maxSlope: 0.88,
    rockAffinity: 0.55, flowAffinity: 0.0, colonyM: 1.6,
    summer: [0.035, 0.105, 0.035], autumn: [0.05, 0.09, 0.035],
    flower: [0.78, 0.16, 0.42], bloom: [6, 8],
    note: 'fell-field cushion (base rate 6k); sandy/gravelly; pink-violet studs',
  },
  {
    id: 'purpleSaxifrage', scientific: 'Saxifraga oppositifolia',
    common: 'Purple saxifrage', cls: 28, form: 'prostrate-mat', abundance: 0.5,
    biome: [0.14, 0.34, 0.1, 0.06, 0.06, 0.04],
    moisture: [0.01, 0.32, 0.82], snowTol: 0.5, maxSlope: 0.92,
    rockAffinity: 0.6, flowAffinity: 0.1, colonyM: 2.2,
    summer: [0.055, 0.1, 0.035], autumn: [0.06, 0.09, 0.04],
    flower: [0.62, 0.08, 0.42], bloom: [6, 6],
    note: 'earliest bloomer (base rate 3k); nival/fell gravel; vivid magenta',
  },
  {
    id: 'roseroot', scientific: 'Rhodiola rosea', common: 'Roseroot',
    cls: 29, variant: [0, 1], form: 'erect-forb', abundance: 0.55,
    biome: [0.02, 0.16, 0.16, 0.14, 0.18, 0.1],
    moisture: [0.22, 0.58, 0.92], snowTol: 0.48, maxSlope: 0.76,
    rockAffinity: 0.42, flowAffinity: 0.3, colonyM: 3.5,
    summer: [0.09, 0.16, 0.095], autumn: [0.5, 0.42, 0.12],
    flower: [0.82, 0.68, 0.12], bloom: [6, 7],
    note: 'succulent of moist rocky ledges & stream margins; yellow-green heads',
  },
  {
    id: 'mountainSorrel', scientific: 'Oxyria digyna', common: 'Mountain sorrel',
    cls: 29, variant: [2, 3], form: 'rosette-forb', abundance: 0.5,
    biome: [0.03, 0.2, 0.18, 0.12, 0.16, 0.16],
    moisture: [0.3, 0.62, 1.0], snowTol: 0.5, maxSlope: 0.72,
    rockAffinity: 0.4, flowAffinity: 0.5, colonyM: 3,
    summer: [0.11, 0.17, 0.08], autumn: [0.55, 0.14, 0.08],
    flower: [0.5, 0.12, 0.09], bloom: [6, 7],
    note: 'moist rocky flushes & snow-melt rills; foliage flushes red in autumn',
  },

  // ---- erect forbs — sparse but showy: LOW abundance, DRIFT into patches ----
  {
    id: 'niviarsiaq', scientific: 'Chamerion latifolium',
    common: 'Niviarsiaq (dwarf fireweed)', cls: 9, form: 'erect-forb',
    abundance: 0.95,
    biome: [0.01, 0.16, 0.2, 0.16, 0.32, 0.14],
    moisture: [0.16, 0.5, 0.9], snowTol: 0.5, maxSlope: 0.6,
    rockAffinity: 0.25, flowAffinity: 0.55, colonyM: 4,
    summer: [0.05, 0.1, 0.04], autumn: [0.4, 0.22, 0.06],
    flower: [0.64, 0.12, 0.36], bloom: [7, 8],
    note: "Greenland's national flower; showy magenta drifts on river gravel/outwash",
  },
  {
    id: 'arcticPoppy', scientific: 'Papaver radicatum', common: 'Arctic poppy',
    cls: 14, form: 'erect-forb', abundance: 0.35,
    biome: [0.08, 0.36, 0.12, 0.1, 0.32, 0.1],
    moisture: [0.02, 0.28, 0.7], snowTol: 0.48, maxSlope: 0.82,
    rockAffinity: 0.45, flowAffinity: 0.1, colonyM: 2.6,
    summer: [0.06, 0.12, 0.05], autumn: [0.08, 0.1, 0.05],
    flower: [0.92, 0.72, 0.1], bloom: [6, 7],
    note: 'sparse (base rate 800) but sun-tracking yellow; fell gravel drifts',
  },
  {
    id: 'harebell', scientific: 'Campanula gieseckeana', common: 'Arctic harebell',
    cls: 13, form: 'erect-forb', abundance: 0.5,
    biome: [0, 0.05, 0.12, 0.16, 0.34, 0.1],
    moisture: [0.18, 0.5, 0.82], snowTol: 0.44, maxSlope: 0.62,
    rockAffinity: 0.05, flowAffinity: 0.1, colonyM: 3.2,
    summer: [0.06, 0.12, 0.05], autumn: [0.08, 0.1, 0.05],
    flower: [0.34, 0.3, 0.62], bloom: [7, 8],
    note: 'blue-violet nodding bells of warm meadow & grassy heath',
  },
  {
    id: 'avensUmbel', scientific: 'Saxifraga / Cochlearia',
    common: 'White saxifrage / scurvygrass umbels', cls: 12, form: 'rosette-forb',
    abundance: 0.7,
    biome: [0.05, 0.3, 0.2, 0.12, 0.28, 0.14],
    moisture: [0.1, 0.45, 0.85], snowTol: 0.5, maxSlope: 0.7,
    rockAffinity: 0.35, flowAffinity: 0.25, colonyM: 2.8,
    summer: [0.06, 0.12, 0.05], autumn: [0.08, 0.1, 0.05],
    flower: [0.86, 0.85, 0.78], bloom: [6, 8],
    note: 'mixed white-flowered rosette guild (visual variant bucket)',
  },

  // ---- wetland graminoids & clonal (mire / fen / channel) ------------------
  {
    id: 'cottongrass', scientific: 'Eriophorum angustifolium',
    common: 'Cottongrass', cls: 15, form: 'graminoid', abundance: 1.4,
    biome: [0, 0, 0.03, 0.04, 0.08, 0.62],
    moisture: [0.58, 0.9, 1.08], snowTol: 0.5, maxSlope: 0.34,
    rockAffinity: -0.4, flowAffinity: 0.5, colonyM: 5.5,
    summer: [0.06, 0.14, 0.05], autumn: [0.5, 0.42, 0.12],
    flower: [0.95, 0.96, 0.97], bloom: [6, 8],
    note: 'mire/fen sedge (base rate 30k, wetness²); white seed-head tufts',
  },
  {
    id: 'horsetail', scientific: 'Equisetum arvense', common: 'Field horsetail',
    cls: 30, variant: [0, 1], form: 'horsetail', abundance: 0.9,
    biome: [0, 0.02, 0.1, 0.12, 0.22, 0.4],
    moisture: [0.55, 0.88, 1.08], snowTol: 0.5, maxSlope: 0.4,
    rockAffinity: -0.2, flowAffinity: 0.7, colonyM: 4.5,
    summer: [0.035, 0.115, 0.045], autumn: [0.3, 0.32, 0.1], flower: null,
    bloom: [6, 7],
    note: 'clonal colony on saturated alluvium & channel margins (base rate 15k)',
  },
  {
    id: 'sedge', scientific: 'Carex spp.', common: 'Sedge',
    cls: 30, variant: [2, 3], form: 'graminoid', abundance: 1.2,
    biome: [0, 0.03, 0.12, 0.16, 0.3, 0.7],
    moisture: [0.45, 0.82, 1.08], snowTol: 0.5, maxSlope: 0.4,
    rockAffinity: -0.35, flowAffinity: 0.55, colonyM: 4,
    summer: [0.09, 0.135, 0.06], autumn: [0.4, 0.35, 0.1], flower: null,
    bloom: [6, 8],
    note: 'mire/fen tussock graminoid; structural wetland cover (base rate 25k)',
  },
  {
    id: 'cloudberry', scientific: 'Rubus chamaemorus', common: 'Cloudberry',
    cls: 31, variant: [0, 1], form: 'erect-forb', abundance: 0.55,
    biome: [0, 0, 0.06, 0.16, 0.14, 0.4],
    moisture: [0.55, 0.85, 1.08], snowTol: 0.46, maxSlope: 0.38,
    rockAffinity: -0.35, flowAffinity: 0.3, colonyM: 8.5,
    summer: [0.055, 0.135, 0.04], autumn: [0.55, 0.3, 0.06],
    flower: [0.92, 0.46, 0.06], bloom: [6, 7],
    note: 'rhizomatous bog patch; amber fruit; southern wet heath/mire',
  },
  {
    id: 'tundraMushroom', scientific: 'Leccinum / Lactarius',
    common: 'Tundra mushroom', cls: 31, variant: [2, 3], form: 'rosette-forb',
    abundance: 0.33,
    biome: [0, 0, 0.08, 0.22, 0.12, 0.28],
    moisture: [0.4, 0.72, 1.0], snowTol: 0.4, maxSlope: 0.35,
    rockAffinity: -0.3, flowAffinity: 0.2, colonyM: 2.2,
    summer: [0.5, 0.44, 0.36], autumn: [0.5, 0.42, 0.34],
    flower: [0.55, 0.16, 0.08], bloom: [7, 9],
    note: 'base rate 2k; clusters in damp sheltered ground near shrubs; red-brown caps',
  },

  // ---- fern (sheltered / shaded moist) -------------------------------------
  {
    id: 'ladyFern', scientific: 'Athyrium / Cystopteris', common: 'Alpine fern',
    cls: 11, form: 'fern', abundance: 0.4,
    biome: [0, 0, 0.05, 0.16, 0.06, 0.16],
    moisture: [0.45, 0.8, 1.05], snowTol: 0.5, maxSlope: 0.48,
    rockAffinity: 0.2, flowAffinity: 0.35, colonyM: 3.5,
    summer: [0.045, 0.14, 0.028], autumn: [0.45, 0.4, 0.1], flower: null,
    bloom: [6, 8],
    note: 'frond rosette in sheltered rock crevices & wet hollows',
  },
] as const;

/**
 * Expansion candidates for the variant-packing runway (real Greenland species
 * from the research catalog, meshes not yet built). Add as new variants of an
 * existing archetype class. Autumn variants (bilberry, bearberry, birch) are the
 * research's "single highest-impact addition for Arctic mood".
 */
export const GREENLAND_FLORA_CANDIDATES: readonly Partial<FloraSpecies>[] = [
  { id: 'bogBilberry', scientific: 'Vaccinium uliginosum', common: 'Bog bilberry', form: 'dwarf-shrub', abundance: 1.7, note: 'base rate 10k; brilliant crimson autumn; pack as crowberry/birch variant' },
  { id: 'bearberry', scientific: 'Arctous alpina', common: 'Alpine bearberry', form: 'prostrate-mat', abundance: 1.3, note: 'base rate 8k; glossy green → scarlet autumn (already a crowberry variant colour)' },
  { id: 'cassiope', scientific: 'Cassiope tetragona', common: 'Arctic bell-heather', form: 'dwarf-shrub', abundance: 1.2, note: 'base rate 8k; snow-bed heath; nodding white bells' },
  { id: 'sedge', scientific: 'Carex spp.', common: 'Sedges', form: 'graminoid', abundance: 1.0, note: 'mire/fen blades & tussocks; distinct from cottongrass' },
  { id: 'mountainSorrel', scientific: 'Oxyria digyna', common: 'Mountain sorrel', form: 'rosette-forb', abundance: 0.5, note: 'moist rocky flushes; red-tinted autumn' },
  { id: 'tundraMushroom', scientific: 'Lactarius / Leccinum', common: 'Tundra mushroom', form: 'rosette-forb', abundance: 0.33, note: 'base rate 2k; clusters near birch/willow; damp sheltered' },
];

/*
 * SOURCES — stored Greenland flora research (base rates, density formulas,
 * palettes) + real arctic-vegetation ecology:
 * - field research — per-species base rate /km², max/tile,
 *   LOD budgets, colour palettes, autumn-variant guidance.
 * - .../biome-rules.md & biome-rules-expansion.md — density formulas keyed on
 *   lat / altitude / slope / wetness (mapped here onto the engine's biome zones
 *   and moisture/rock/flow/snow fields).
 * - Atlantis field-validation notes — composition checks against reference
 *   imagery and the project Arctic species catalog.
 * - CAVM (UAF Geobotany) prostrate-shrub tundra (Dryas/Salix); Encyclopedia
 *   Arctica 6 "Flora and Vegetation of Greenland"; Visit Greenland flora.
 */
