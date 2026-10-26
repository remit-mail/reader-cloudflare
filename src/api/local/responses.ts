export const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> => {
  const entry: Partial<Record<K, V>> = {};
  if (value === null || value === undefined) return entry;
  entry[key] = value;
  return entry;
};
