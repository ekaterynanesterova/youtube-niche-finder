// Учёт квоты YouTube Data API. Лимит — 10 000 юнитов в сутки на проект.
// Стоимости: search.list = 100, всё остальное, чем мы пользуемся = 1.

export const COST = {
  'search': 100,
  'videos': 1,
  'channels': 1,
  'playlistItems': 1,
};

export class BudgetExhausted extends Error {
  constructor(spent, budget) {
    super(`Бюджет квоты исчерпан: потрачено ${spent} из ${budget}`);
    this.name = 'BudgetExhausted';
  }
}

export class Quota {
  constructor(budget) {
    this.budget = budget;
    this.spent = 0;
    this.byEndpoint = {};
  }

  // Хватит ли на вызов — без списания.
  canAfford(endpoint) {
    return this.spent + (COST[endpoint] ?? 1) <= this.budget;
  }

  spend(endpoint) {
    const cost = COST[endpoint] ?? 1;
    if (this.spent + cost > this.budget) throw new BudgetExhausted(this.spent, this.budget);
    this.spent += cost;
    this.byEndpoint[endpoint] = (this.byEndpoint[endpoint] ?? 0) + cost;
    return cost;
  }

  remaining() { return this.budget - this.spent; }

  summary() {
    return { budget: this.budget, spent: this.spent, byEndpoint: { ...this.byEndpoint } };
  }
}
