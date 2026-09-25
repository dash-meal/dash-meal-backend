import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageQuery, pageRange, paginationMeta } from "../src/utils/pagination.js";

// Formules d'origine (avant refactoring #14), recopiées telles quelles
function legacy(query: Record<string, unknown>) {
  const page  = Math.max(1, parseInt(query.page  as string) || 1);
  const limit = Math.min(50, parseInt(query.limit as string) || 20);
  const from  = (page - 1) * limit;
  return { page, limit, range: [from, from + limit - 1] };
}

const queries: Record<string, unknown>[] = [
  {}, { page: "1" }, { page: "3", limit: "10" }, { page: "0" }, { page: "-4" },
  { limit: "999" }, { limit: "50" }, { limit: "0" }, { limit: "-5" },
  { page: "abc", limit: "xyz" }, { page: "2.7", limit: "15abc" }, { page: ["2"], limit: undefined },
];

test("parsePageQuery + pageRange identiques à l'ancien calcul", () => {
  for (const q of queries) {
    const { page, limit } = parsePageQuery(q);
    assert.deepEqual({ page, limit, range: pageRange(page, limit) }, legacy(q), JSON.stringify(q));
  }
});

test("paginationMeta identique à l'ancien bloc pagination", () => {
  for (const [page, limit, total] of [[1, 20, 0], [1, 20, 1], [2, 20, 40], [3, 20, 41], [1, 50, 1234]]) {
    assert.deepEqual(paginationMeta(page, limit, total), {
      page, limit, total, total_pages: Math.ceil(total / limit),
    });
  }
});

test("pageRange : bornes inclusives pour supabase", () => {
  assert.deepEqual(pageRange(1, 20), [0, 19]);
  assert.deepEqual(pageRange(3, 10), [20, 29]);
});
