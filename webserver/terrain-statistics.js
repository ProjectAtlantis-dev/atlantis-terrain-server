export function sortedPercentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.floor(sortedValues.length * fraction),
  );
  return sortedValues[index];
}
