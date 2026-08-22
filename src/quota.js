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
    // Броня для снапшота. Разведка идёт первой и раньше съедала бюджет целиком:
    // снапшот доходил до 72 000 видео из 95 000 и обрывался — всё, что нашли
    // в тот же день, оставалось без единой цифры. Ради снапшота проект и
    // затевался, поэтому его доля откладывается заранее и остальным слоям
    // недоступна.
    this.reserved = 0;
  }

  reserve(units) { this.reserved = Math.max(0, Math.min(units, this.budget - this.spent)); }

  // Хватит ли на вызов — без списания. Броню трогает только тот, кто её и просил.
  canAfford(endpoint, { useReserve = false } = {}) {
    const ceiling = this.budget - (useReserve ? 0 : this.reserved);
    return this.spent + (COST[endpoint] ?? 1) <= ceiling;
  }

  spend(endpoint, { useReserve = false } = {}) {
    const cost = COST[endpoint] ?? 1;
    const ceiling = this.budget - (useReserve ? 0 : this.reserved);
    if (this.spent + cost > ceiling) throw new BudgetExhausted(this.spent, ceiling);
    this.spent += cost;
    this.byEndpoint[endpoint] = (this.byEndpoint[endpoint] ?? 0) + cost;
    return cost;
  }

  remaining({ useReserve = false } = {}) {
    return this.budget - (useReserve ? 0 : this.reserved) - this.spent;
  }

  summary() {
    return { budget: this.budget, spent: this.spent, byEndpoint: { ...this.byEndpoint } };
  }
}
