/** The key's `.one` form for 1, its `.many` form otherwise, so each language writes its own agreement. */
export const countWords = (t, key, count, params = {}) => t(`${key}.${count === 1 ? "one" : "many"}`, { count, ...params });
