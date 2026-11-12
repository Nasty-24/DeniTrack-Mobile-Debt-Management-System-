/**
 * What was taken on credit is typed one item per line. Lists and receipts have room for a
 * single line, so they show the items joined with commas: "Sugar 2kg, Bread, Milk 1L".
 */
export function itemsOnOneLine(description: string): string {
  return description
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[,;]+$/, ''))
    .filter(Boolean)
    .join(', ');
}
