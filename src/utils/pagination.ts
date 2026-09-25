// ─── Pagination ───────────────────────────────────────────────────────────────

/** Lit ?page & ?limit : page ≥ 1, limit plafonné à maxLimit. */
export function parsePageQuery(
  query: Record<string, unknown>,
  defaultLimit = 20,
  maxLimit = 50,
): { page: number; limit: number } {
  const page  = Math.max(1, parseInt(query.page  as string) || 1);
  const limit = Math.min(maxLimit, parseInt(query.limit as string) || defaultLimit);
  return { page, limit };
}

/** Bornes [from, to] inclusives pour supabase .range() */
export function pageRange(page: number, limit: number): [number, number] {
  const from = (page - 1) * limit;
  return [from, from + limit - 1];
}

export function paginationMeta(page: number, limit: number, total: number) {
  return { page, limit, total, total_pages: Math.ceil(total / limit) };
}
