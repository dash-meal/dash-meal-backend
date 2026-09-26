import { describe, it, expect } from "vitest";
import { escapePostgrestValue } from "./postgrest.js";

describe("escapePostgrestValue", () => {
  it("entoure une valeur simple de guillemets doubles", () => {
    expect(escapePostgrestValue("hello")).toBe('"hello"');
  });

  it("neutralise une virgule qui casserait hors de la condition .or() (injection de condition)", () => {
    // Sans échappement : `name.ilike.%${q}%,is_active.eq.true`.or(...) ajouterait
    // une condition OR arbitraire. Avec échappement, la virgule reste une
    // donnée littérale à l'intérieur de la valeur entre guillemets.
    const malicious = "x%,is_active.eq.true";
    const escaped = escapePostgrestValue(malicious);
    expect(escaped).toBe('"x%,is_active.eq.true"');
    // La valeur entière doit être contenue dans UNE paire de guillemets,
    // pas de virgule "libre" (hors guillemets) qui délimiterait une nouvelle condition.
    expect(escaped.indexOf('"')).toBe(0);
    expect(escaped.lastIndexOf('"')).toBe(escaped.length - 1);
  });

  it("neutralise une parenthèse fermante qui casserait un groupe .or()", () => {
    const malicious = "x),and(id.neq.0";
    const escaped = escapePostgrestValue(malicious);
    expect(escaped).toBe('"x),and(id.neq.0"');
  });

  it("échappe les guillemets doubles internes avec un backslash", () => {
    expect(escapePostgrestValue('he said "hi"')).toBe('"he said \\"hi\\""');
  });

  it("échappe les backslashes avant de les doubler (pour ne pas échapper accidentellement le guillemet suivant)", () => {
    expect(escapePostgrestValue("a\\b")).toBe('"a\\\\b"');
  });

  it("laisse les caractères % (wildcards ILIKE) intacts", () => {
    expect(escapePostgrestValue("%recherche%")).toBe('"%recherche%"');
  });

  it("gère une chaîne vide", () => {
    expect(escapePostgrestValue("")).toBe('""');
  });
});
