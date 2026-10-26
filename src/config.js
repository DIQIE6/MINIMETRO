/**
 * Central tuning table. Everything that a designer would want to twiddle lives
 * here so the simulation modules stay free of magic numbers.
 */

export const CONFIG = {
  // Logical play area. The renderer letterboxes this into the viewport.
  world: { w: 1600, h: 1000, margin: 86 },

  /**
   * The map is revealed gradually: at the start you see a small patch around a
   * bend of the main river, and over one in-game week the view opens out until
   * the whole map is visible. New stations only ever appear inside what you can
   * currently see.
   */
  view: {
    /** Linear fraction of the map visible at the start. 0.35 is ~12% of the area. */
    startFraction: 0.35,
    /** Seconds from the first frame to the full map: two in-game weeks. */
    rampSeconds: 140,
    /**
     * Shape of the reveal. 2 = quadratic ease-in: the view stays small through
     * the whole first week and only opens out during the second, instead of
     * being more than half open by the end of week one.
     */
    curve: 2,
    /**
     * Station radius multiplier at the start. The final size is unchanged (1.0);
     * this multiplies the world radius while the map is zoomed in, so at the
     * start a station is stationScaleAtStart / startFraction times its final
     * on-screen size. 1.25 with startFraction 0.35 gives 3.6x.
     */
    stationScaleAtStart: 1.25,
    /** New stations keep this fraction of the view as a border. */
    margin: 0.07,
  },

  grid: {
    size: 40,
    minStationGap: 108,
    preferredMinDist: 150,
    preferredMaxDist: 340,
    placementTries: 260,
    /** How far a station may drift from the centre of its grid cell (0..0.5).
     *  Keeps the good spacing of a lattice without looking like one. */
    jitter: 0.38,
    /** A candidate sitting almost on the line through two existing stations is
     *  pushed away: three in a row is the most predictable layout there is. */
    collinearWindow: 26,
    collinearPenalty: 620,
    /** Mild pull towards sharing a row/column, well below the penalty above. */
    alignmentWindow: 22,
    alignmentBias: 18,
    /**
     * Stations on the far side of the water are heavily discouraged at first
     * and allowed through gradually, so the opening network does not need a
     * tunnel straight away. The penalty fades from full at \u0060acrossRiverFromDay\u0060
     * to nothing at \u0060acrossRiverFullDay\u0060.
     */
    acrossRiverPenalty: 2600,
    acrossRiverFromDay: 7,
    acrossRiverFullDay: 28,
  },

  /**
   * Hills. A map is mostly plain: at most a couple of solid hills, each one
   * between 5% and 15% of the map, none of them overlapping the water.
   */
  terrain: {
    /** How many hills a map may have. */
    count: [0, 2],
    /** Each hill covers at least / at most this share of the map. */
    minArea: 0.05,
    maxArea: 0.15,
    /** How lumpy the outline is; keeps a hill a single smooth mass. */
    wobble: 0.16,
    /** Minimum gap between a hill and the water. */
    riverGap: 34,
    /** Speed multiplier for track laid straight over a hill (no tunnel). */
    surfaceSpeed: 0.55,
    /**
     * A station may never straddle a hill's edge: its disc has to be wholly on
     * the hill or wholly off it, with this much room to spare (world units,
     * scaled with the station). Otherwise a station that "should not be on the
     * mountain" ends up sitting on the green boundary.
     */
    stationClearance: 19,
    /** At most this many stations on any one hill. */
    maxStationsPerHill: 4,
    /** Hills stay empty until this many in-game days have passed. */
    hillFromDay: 14,
    /** Share of hill stations that are scenic rather than residential. */
    hillScenicChance: 0.55,
  },

  /** Track routing: only 0 / 45 / 90 degree segments, joined with round corners. */
  track: {
    cornerRadius: 26,
    cornerSamples: 6,
  },

  river: {
    samplesPerSegment: 14,
    width: 34,
    stationClearance: 58,
    meander: 0.42, // 0..1 how far a river wanders from the straight line
    /** Short-wavelength wobble on top of the long bend (tools/river-lab.html). */
    wiggle: 0.18,
    /** Chance of an extra tributary. */
    branchChance: 0.5,
    /** How many rivers the map gets, tributaries and braids not included. */
    count: [1, 2],
    /** Extra tributaries that split off and often rejoin elsewhere. */
    branchCount: [0, 1],
    /** Chance a tributary flows into another stretch of water. */
    confluenceChance: 0.6,
    /** The water must span at least this fraction of the map diagonal. */
    minSpan: 0.7,
    /** Chance the river braids: splits and rejoins around an island (江心洲). */
    braidChance: 0.62,
    /** Most braided reaches (river islands) a map may have: 0 to this. */
    braidCount: 3,
    /** At most this many islands on any one river. */
    maxBraidsPerRiver: 1,
  },

  station: {
    capacity: 6,
    interchangeCapacity: 9,
    overcrowdSeconds: 42,
    initialCount: 3,
    spawnIntervalStart: 27,
    spawnIntervalEnd: 15,
    spawnIntervalRamp: 720, // seconds of play to reach the end value
    /** The opening week is deliberately quiet: at most this many extra stations. */
    firstWeekDays: 7,
    firstWeekExtra: 3,
    specialFirstAfter: 6, // specials start once this many normal stations exist
    specialEvery: 7,
    /** Special districts sit out towards the edges of the map. */
    specialPeripheralBias: 260,
  },

  passenger: {
    // Seconds between passenger arrivals at a single station.
    intervalStart: [20.0, 33.0],
    intervalEnd: [7.8, 13.5],
    intervalRamp: 420,
    burstChance: 0.06, // occasional double spawn
    /**
     * How much traffic each district produces, relative to a circle. A circle
     * (住宅区) is the busiest source on the map; a bank is nearly empty.
     */
    spawnWeight: {
      circle: 1,
      triangle: 0.66,
      square: 0.8,
      cross: 0.3,
      star: 0.3,
      diamond: 0.32,
      pentagon: 0.22,
      fan: 0.3,
      gem: 0.3,
    },
    /**
     * Where the people from each district want to go. A weight of 0 (or a
     * missing entry) means that trip is simply never generated - that is what
     * makes circles never travel to a bank, and a hospital only swap people
     * with housing.
     */
    flows: {
      circle: { square: 3, triangle: 3, star: 1, cross: 1, diamond: 1, fan: 1, pentagon: 0 },
      triangle: { circle: 8, pentagon: 2, star: 1 },
      square: { circle: 2, triangle: 2, star: 1, diamond: 1, cross: 1, fan: 1, pentagon: 1 },
      cross: { circle: 1 },
      pentagon: { circle: 3, square: 2 },
      star: { circle: 2, triangle: 2 },
      diamond: { circle: 2, square: 2 },
      fan: { circle: 1 },
      gem: { circle: 1 },
    },
    /**
     * Occasional rush at one special district: a tourist season, a match day,
     * a flu outbreak. Specials are quiet most of the time and then dump a
     * crowd on the platform all at once.
     */
    /** District surges only start once the score is past this. */
    eventAfterScore: 1500,
    eventInterval: [55, 130],
    eventSize: [3, 6],
  },

  vehicles: {
    startLocomotives: 3,
    /** One spare carriage so the tray has something to drag from day one. */
    startCarriages: 1,
    /** A single train can grow to a head plus this many carriages. */
    maxCarriages: 5,
  },

  train: {
    /** Top speed between stations. */
    cruiseSpeed: 96,
    /** Speed the train is still doing as it rolls into a platform. */
    minSpeed: 20,
    /** Distance over which the train eases off for the next station: it only
     *  slows down "a little before" the platform, then runs fast in between. */
    brakeDistance: 64,
    /** How hard it can accelerate / brake, in units per second squared. */
    acceleration: 130,
    dwell: 0.32,
    boardTime: 0.1,
    baseCapacity: 6,
    carriageCapacity: 6,
  },

  clock: {
    /** One in-game day at 1x speed. */
    daySeconds: 10,
    daysPerWeek: 7,
  },

  score: {
    perPassenger: 1,
    specialBonus: 5,
  },

  lines: {
    startSlots: 3,
    /**
     * Centre-to-centre distance between two lines sharing a stretch of track.
     * The bands are 7 wide, so this leaves about a 2px gap: they read as a
     * double track rather than as two separate lines. Grabbing still works
     * because the hit test takes whichever is nearer.
     */
    overlapGap: 9,
    /** Angle between two terminus T markers that share a station. */
    terminusFan: 0.42,
    maxSlots: 7,
    /** Passengers tolerate this many "stops" of detour before a transfer looks better. */
    transferPenalty: 2.5,
    /** Hard cap on how long a train keeps finishing an old route. */
    retireSeconds: 90,
    /** Same cap, for a train finishing the route of a line that was edited. */
    transitionSeconds: 70,
  },

  tunnels: {
    /** Mini Metro hands you a few tunnels on day one; so do we. */
    start: 3,
    perPick: 2,
  },

  rewards: {
    optionsPerWeek: 2,
    thirdOptionFromWeek: 8,
  },

  modes: {
    normal: { id: 'normal', label: '普通', overcrowdFatal: true },
    endless: { id: 'endless', label: '无尽', overcrowdFatal: false },
  },
};

export const LINE_COLORS = [
  { id: 'red', name: '红线', stroke: '#e2564a', dark: '#b8402f' },
  { id: 'blue', name: '蓝线', stroke: '#3d7fd0', dark: '#2b5f9e' },
  { id: 'green', name: '绿线', stroke: '#4aa85c', dark: '#357f42' },
  { id: 'yellow', name: '黄线', stroke: '#efc22e', dark: '#c79a12' },
  { id: 'purple', name: '紫线', stroke: '#9a63c4', dark: '#734399' },
  { id: 'orange', name: '橙线', stroke: '#f08b3c', dark: '#c6661d' },
  { id: 'cyan', name: '青线', stroke: '#31b3bd', dark: '#1d878f' },
];

export const PALETTE = {
  bg: '#f2efe8',
  bgAlt: '#e8e4da',
  river: '#c7e3f2',
    mountain: '#a9cf8f',
    mountainEdge: '#8fb874',
  riverEdge: '#a9d2e8',
  ink: '#39393b',
  inkSoft: '#6d6d70',
  paper: '#ffffff',
  danger: '#e2564a',
  special: '#fff3d6',
};




