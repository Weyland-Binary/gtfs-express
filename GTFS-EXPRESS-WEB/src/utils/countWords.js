/**
 * countWords — a count said in words: the key's `.one` form for 1, its `.many` form otherwise, each with `{count}`
 * (the 7 languages write their own agreement there instead of « ligne(s) »).
 */
export const countWords = (t, key, count, params = {}) => t(`${key}.${count === 1 ? "one" : "many"}`, { count, ...params });
