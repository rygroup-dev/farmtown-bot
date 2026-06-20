import fs from 'node:fs';

export function loadEconomy(path = 'data/economy.json') {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function profitPerHour(c) {
  const hours = (c.growSeconds || 1) / 3600;
  return (c.sell - c.cost) / hours;
}

export function xpPerHour(c) {
  const hours = (c.growSeconds || 1) / 3600;
  return (c.xp || 0) / hours;
}

export function rankCrops(eco, { gold = 0, level = 1, objective = 'gold' } = {}) {
  const score = (c) =>
    objective === 'xp' ? xpPerHour(c)
    : objective === 'balanced' ? profitPerHour(c) * 0.7 + xpPerHour(c) * 0.3
    : profitPerHour(c);
  return Object.values(eco)
    .filter((c) => (c.unlockLevel || 1) <= level && c.cost <= gold)
    .map((c) => ({ ...c, score: score(c) }))
    .sort((a, b) => b.score - a.score);
}
