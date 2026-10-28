/**
 * GS-UI-01 — display formatting for real scene provenance.
 *
 * These helpers never invent data: a missing/invalid value returns ``null`` so
 * the card can omit the chip entirely (seeded scenes have no upload session).
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Format an ISO upload timestamp as ``YYYY-MM-DD HH:mm`` in the viewer's local
 * timezone. Returns null for missing/invalid input.
 */
export function formatUploadTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/**
 * Uppercase the ORIGINAL uploaded file extension (e.g. ``ply`` → ``PLY``).
 * Returns null for empty values; never derives a format from content URLs.
 */
export function formatOriginalFormat(format: string | null | undefined): string | null {
  if (!format) return null;
  const token = format.trim().replace(/^\./, '');
  if (!token) return null;
  return token.toUpperCase();
}
