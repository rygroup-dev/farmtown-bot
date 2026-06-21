export class GameState {
  constructor() {
    this.gold = 0; this.xp = 0; this.level = 1; this.stars = 0;
    this.inventory = {}; this.inventoryCapacity = 30; this.tiles = new Map();
    this.playerId = null; this.pos = { x: 784, y: 784 };
    this.cropInventory = {}; this.orders = []; this.farmJobs = [];
    this.starterTasks = { currentTaskId: null, completed: [] };
    this.selectedTool = null; this.selectedSeedId = null;
    this.cropMastery = {}; this.questChapters = null;
    this.farmValue = 0; this.farmRank = 0; this.farmPoints = 0;
    this.completedOrdersCount = 0; this.completedFarmJobsCount = 0; this.totalHarvestedCrops = 0;
  }
  key(x, y) { return `${x},${y}`; }
  apply(event, data) {
    switch (event) {
      case 'farm:snapshot':
      case 'farm:state/sync': {
        for (const t of (data.tiles || [])) this.tiles.set(this.key(t.x, t.y), t);
        break;
      }
      case 'player:farmState/sync': {
        const f = data.farmState || {};
        if (f.gold != null) this.gold = f.gold;
        if (f.xp != null) this.xp = f.xp;
        if (f.level != null) this.level = f.level;
        if (f.premiumBalance?.stars != null) this.stars = f.premiumBalance.stars;
        if (f.inventoryCapacity != null) this.inventoryCapacity = f.inventoryCapacity;
        if (f.inventory) this.inventory = { ...this.inventory, ...f.inventory };
        if (f.cropInventory) this.cropInventory = { ...this.cropInventory, ...f.cropInventory };
        if (f.orders) this.orders = f.orders;
        if (f.farmJobs) this.farmJobs = f.farmJobs;
        if (f.starterTasks) this.starterTasks = f.starterTasks;
        if (f.selectedTool != null) this.selectedTool = f.selectedTool;
        if (f.selectedSeedId != null) this.selectedSeedId = f.selectedSeedId;
        if (f.cropMastery) this.cropMastery = f.cropMastery;
        if (f.questChapters) this.questChapters = f.questChapters;
        if (f.farmValue != null) this.farmValue = f.farmValue;
        if (f.farmRank != null) this.farmRank = f.farmRank;
        if (f.farmPoints != null) this.farmPoints = f.farmPoints;
        if (f.completedOrdersCount != null) this.completedOrdersCount = f.completedOrdersCount;
        if (f.completedFarmJobsCount != null) this.completedFarmJobsCount = f.completedFarmJobsCount;
        if (f.totalHarvestedCrops != null) this.totalHarvestedCrops = f.totalHarvestedCrops;
        break;
      }
      case 'tile:update': {
        if (data.tile) this.tiles.set(this.key(data.tile.x, data.tile.y), data.tile);
        for (const t of (data.changedTiles || [])) this.tiles.set(this.key(t.x, t.y), t);
        break;
      }
      case 'game:actionResult': {
        if (data.ok && data.inventoryDelta?.seeds) for (const [k, v] of Object.entries(data.inventoryDelta.seeds)) this.inventory[k] = (this.inventory[k] || 0) + v;
        // The action result carries the updated tile(s) — apply immediately so the next
        // tick doesn't re-target an already-harvested/changed tile ("Nothing ready" race).
        if (data.ok && data.tile) this.tiles.set(this.key(data.tile.x, data.tile.y), data.tile);
        if (data.ok) for (const t of (data.changedTiles || [])) this.tiles.set(this.key(t.x, t.y), t);
        break;
      }
    }
  }
  ownedTiles() { return [...this.tiles.values()].filter(t => t.ownerState === 'owned'); }
  tilledEmpty() { return this.ownedTiles().filter(t => t.groundState === 'tilled' && !t.cropId && t.blocker === 'none'); }
  grassEmpty() { return this.ownedTiles().filter(t => t.groundState === 'grass' && t.blocker === 'none'); }
  // Tiles that need hoeing before planting: fresh grass OR 'cleared' ground (left
  // after a blocker is cleared or a crop is harvested/removed). Both → hoe → 'tilled'.
  hoeable() { return this.ownedTiles().filter(t => (t.groundState === 'grass' || t.groundState === 'cleared') && t.blocker === 'none' && !t.cropId); }
  blocked() { return this.ownedTiles().filter(t => t.blocker && t.blocker !== 'none'); }
  // Ready to harvest, with a 1.5s buffer so we never fire before the SERVER agrees
  // (avoids "Nothing ready" races), and excluding crops that have already died.
  // Harvest whatever the SERVER says is ripe (groundState 'ready') — even if its diesAt
  // has passed: while the tile is still 'ready' the crop is harvestable, the server just
  // hasn't reaped it. (The old diesAt>now guard made the bot REFUSE overdue-but-ready
  // crops, leaving 50 tiles stuck + idle after a long disconnect.) The timing branch is
  // a fallback (with a 3s buffer to dodge "Nothing ready" races) for snapshots that
  // carry readyAt but not yet groundState 'ready'. Truly dead crops are groundState
  // 'dead' → handled by deadCrops()/clearDead, not here.
  readyToHarvest() {
    const now = Date.now();
    return this.ownedTiles().filter(t => t.cropId && (
      t.groundState === 'ready' ||
      (t.readyAt && t.readyAt <= now - 3000 && (!t.diesAt || t.diesAt > now))
    ));
  }
  // Crops the server has marked DEAD (groundState 'dead') — ripened past their death
  // window, typically while we were disconnected. They block the tile (can't harvest,
  // can't replant) until removed with crop:clearDead, so the brain must clear them.
  deadCrops() { return this.ownedTiles().filter(t => t.groundState === 'dead'); }
  buyableTiles() { return [...this.tiles.values()].filter(t => t.ownerState === 'buyable' || t.ownerState === 'locked'); }
  // Locked tiles orthogonally adjacent to owned land — the only plots you can buy
  // ("Locked tiles must be adjacent to your owned area"). Server validates the price.
  expandableTiles() {
    const owned = new Set(this.ownedTiles().map(t => this.key(t.x, t.y)));
    return [...this.tiles.values()].filter(t => t.ownerState === 'locked' && (
      owned.has(this.key(t.x - 1, t.y)) || owned.has(this.key(t.x + 1, t.y)) ||
      owned.has(this.key(t.x, t.y - 1)) || owned.has(this.key(t.x, t.y + 1))
    ));
  }
  completableOrders() {
    return this.orders.filter(o => o.requires && Object.entries(o.requires).every(([c, q]) => (this.cropInventory[c] || 0) >= q));
  }
  claimableJobs() {
    return this.farmJobs.filter(j => (j.current || 0) >= (j.target || Infinity));
  }
  seedCount() { return Object.values(this.inventory).reduce((a, b) => a + (b || 0), 0); }
  cropDemand() {
    const d = {};
    for (const o of this.orders) for (const [c, q] of Object.entries(o.requires || {})) d[c] = (d[c] || 0) + q;
    return d;
  }
  // How many of each crop are currently growing on owned tiles, keyed by lowercase
  // crop id (so it can be netted against order demand). Lets the brain avoid
  // over-planting a single order crop when enough is already in the ground.
  growingCounts() {
    const d = {};
    for (const t of this.ownedTiles()) if (t.cropId) {
      const id = String(t.cropId).toLowerCase().replace(/_seed$/, '');
      d[id] = (d[id] || 0) + 1;
    }
    return d;
  }
}
