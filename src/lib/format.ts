/** Display formatters (round-at-display per the data-layer precision rule). */

export function aed(n: number): string {
  return "AED " + Math.round(n).toLocaleString("en-US");
}

export function intFmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function roasFmt(n: number): string {
  return n.toFixed(1) + "x";
}

export function pctFmt(n: number): string {
  return (n * 100).toFixed(2) + "%";
}
