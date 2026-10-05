// ─── Échappement des valeurs dans les filtres PostgREST construits à la main ──
//
// Supabase/PostgREST interprète les chaînes passées à .or(...) / .filter(...)
// comme une mini-syntaxe : "colonne.opérateur.valeur", plusieurs conditions
// séparées par des virgules, éventuellement groupées avec des parenthèses.
// Quand une valeur vient d'une entrée utilisateur et est insérée par simple
// concaténation de chaîne (ex: `.or(\`name.ilike.%${q}%\`)`), un caractère
// comme `,` ou `)` dans cette valeur peut casser hors de la condition prévue :
// injection d'une condition OR supplémentaire, exposition de colonnes non
// voulues, ou contournement d'un filtre.
//
// PostgREST permet d'entourer une valeur de guillemets doubles pour neutraliser
// les caractères réservés (`,` `.` `:` `(` `)` et le guillemet double
// lui-même, qui doit alors être échappé par un backslash). C'est ce que fait
// cette fonction — à utiliser pour TOUTE valeur d'origine utilisateur insérée
// dans une chaîne de filtre PostgREST construite manuellement.
//
// Référence : https://postgrest.org/en/stable/references/api/tables_views.html#operators
export function escapePostgrestValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
