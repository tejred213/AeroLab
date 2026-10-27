/** Client-side export helpers: JSON, CSV, SVG and PNG downloads. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), filename);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Builds CSV text from a header row and data rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function downloadCsv(headers: string[], rows: unknown[][], filename: string): void {
  downloadBlob(new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }), filename);
}

const CHART_BACKGROUND = "#14171c";

/** Serialises an on-screen SVG as a standalone document with a solid background. */
export function serializeSvg(svg: SVGSVGElement): { text: string; width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(Math.round(rect.width), 1);
  const height = Math.max(Math.round(rect.height), 1);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  // Text inherits its font from the page; make it explicit for the standalone file.
  clone.setAttribute("font-family", "Archivo, system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif");
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", CHART_BACKGROUND);
  clone.insertBefore(background, clone.firstChild);
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

export function downloadSvg(svg: SVGSVGElement, filename: string): void {
  downloadBlob(new Blob([serializeSvg(svg).text], { type: "image/svg+xml;charset=utf-8" }), filename);
}

/** Rasterises an SVG to PNG at 2x resolution. */
export async function downloadPng(svg: SVGSVGElement, filename: string): Promise<void> {
  const { text, width, height } = serializeSvg(svg);
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not rasterise the chart."));
      image.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available.");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG.");
    downloadBlob(blob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** File-name-safe version of a title. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
