export class GameState {
  constructor() {
    this.gold = 0; this.xp = 0; this.level = 1; this.stars = 0;
    this.inventory = {}; this.tiles = new Map();
    this.playerId = null; this.pos = { x: 784, y: 784 };
    this.cropInventory = {}; this.orders = []; this.farmJobs = [];
    this.starterTasks = { currentTaskId: null, completed: [] };
    this.selectedTool = null; this.selectedSeedId = null;
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
        if (f.inventory) this.inventory = { ...this.inventory, ...f.inventory };
        if (f.cropInventory) this.cropInventory = { ...this.cropInventory, ...f.cropInventory };
        if (f.orders) this.orders = f.orders;
        if (f.farmJobs) this.farmJobs = f.farmJobs;
        if (f.starterTasks) this.starterTasks = f.starterTasks;
        if (f.selectedTool != null) this.selectedTool = f.selectedTool;
        if (f.selectedSeedId != null) this.selectedSeedId = f.selectedSeedId;
        break;
      }
      case 'tile:update': {
        if (data.tile) this.tiles.set(this.key(data.tile.x, data.tile.y), data.tile);
        for (const t of (data.changedTiles || [])) this.tiles.set(this.key(t.x, t.y), t);
        break;
      }
      case 'game:actionResult': {
        if (data.ok && data.inventoryDelta?.seeds) for (const [k, v] of Object.entries(data.inventoryDelta.seeds)) this.inventory[k] = (this.inventory[k] || 0) + v;
        break;
      }
    }
  }
  ownedTiles() { return [...this.tiles.values()].filter(t => t.ownerState === 'owned'); }
  tilledEmpty() { return this.ownedTiles().filter(t => t.groundState === 'tilled' && !t.cropId && t.blocker === 'none'); }
  grassEmpty() { return this.ownedTiles().filter(t => t.groundState === 'grass' && t.blocker === 'none'); }
  blocked() { return this.ownedTiles().filter(t => t.blocker && t.blocker !== 'none'); }
  readyToHarvest() { const now = Date.now(); return this.ownedTiles().filter(t => t.cropId && t.readyAt && t.readyAt <= now); }
  buyableTiles() { return [...this.tiles.values()].filter(t => t.ownerState === 'buyable' || t.ownerState === 'locked'); }
  completableOrders() {
    return this.orders.filter(o => o.requires && Object.entries(o.requires).every(([c, q]) => (this.cropInventory[c] || 0) >= q));
  }
  claimableJobs() {
    return this.farmJobs.filter(j => (j.current || 0) >= (j.target || Infinity));
  }
  cropDemand() {
    const d = {};
    for (const o of this.orders) for (const [c, q] of Object.entries(o.requires || {})) d[c] = (d[c] || 0) + q;
    return d;
  }
}
