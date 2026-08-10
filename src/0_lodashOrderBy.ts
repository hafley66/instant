// ESM bridge for @hafley66/grid's named lodash import.
export function orderBy<T>(values: T[], keys: string[], directions: string[]): T[] {
  return [...values].sort((a, b) => {
    for (let i = 0; i < keys.length; i += 1) {
      const left = (a as Record<string, unknown>)[keys[i]];
      const right = (b as Record<string, unknown>)[keys[i]];
      if (left === right) continue;
      const result = left == null ? -1 : right == null ? 1 : left < right ? -1 : 1;
      return directions[i] === "desc" ? -result : result;
    }
    return 0;
  });
}

export default { orderBy };
