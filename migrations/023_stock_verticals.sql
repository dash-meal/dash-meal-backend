-- ============================================================
-- DASH MEAL — Migration 021
-- Modèle de stock multi-vertical (restaurant / supermarché / hypermarché)
-- À exécuter dans l'éditeur SQL Supabase
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. BRANCH VERTICALS
--    Remplace le enum BRANCH_TYPES codé en dur (src/shared/schemas/brand.ts) par
--    une table gérée par le superadmin, pour pouvoir ajouter des profils sans
--    déploiement (pharmacie existe déjà, plus tard "restaurant livraison
--    uniquement", etc.). Pilote le comportement du stock selon le type
--    d'agence (restaurant, supermarché, hypermarché...).
--    On garde les mêmes clés que l'ancien enum pour ne rien casser :
--    supermarket, superette, restaurant, cafe, bakery, pharmacy, other
--    + le nouveau : hypermarket.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS branch_verticals (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key                         TEXT        UNIQUE NOT NULL,
  name_fr                     TEXT        NOT NULL,
  name_en                     TEXT        NOT NULL,
  description                 TEXT,
  decrement_on_order          BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_barcode            BOOLEAN     NOT NULL DEFAULT FALSE,
  requires_unit_type          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Réservé pour une phase ultérieure (non exploité par l'application pour l'instant)
  batch_tracking_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  multi_warehouse_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  low_stock_default_threshold INTEGER     NOT NULL DEFAULT 5,
  is_active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER branch_verticals_updated_at
    BEFORE UPDATE ON branch_verticals
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO branch_verticals (key, name_fr, name_en, description, requires_barcode, requires_unit_type, low_stock_default_threshold)
VALUES
  ('restaurant',  'Restaurant',        'Restaurant',        'Stock au produit fini, sans code-barres ni unité structurée.', FALSE, FALSE, 5),
  ('cafe',        'Café',              'Cafe',              'Comme restaurant.', FALSE, FALSE, 5),
  ('bakery',      'Boulangerie',       'Bakery',            'Comme restaurant.', FALSE, FALSE, 5),
  ('superette',   'Supérette',         'Convenience store', 'Stock par SKU avec code-barres et unité de mesure structurée.', TRUE, TRUE, 8),
  ('supermarket', 'Supermarché',       'Supermarket',       'Stock par SKU avec code-barres et unité de mesure structurée.', TRUE, TRUE, 10),
  ('hypermarket', 'Hypermarché',       'Hypermarket',       'Comme supermarché, avec un seuil d''alerte plus élevé adapté aux gros volumes.', TRUE, TRUE, 20),
  ('pharmacy',    'Pharmacie',         'Pharmacy',          'Stock par SKU avec code-barres et unité de mesure structurée.', TRUE, TRUE, 10),
  ('other',       'Autre',             'Other',             'Profil par défaut, sans exigence particulière.', FALSE, FALSE, 5)
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BRANCHES.VERTICAL_ID
--    Chaque agence est rattachée à un vertical. Colonne ajoutée en parallèle de
--    l'ancienne colonne texte `type` (non supprimée, toujours utilisée pour les
--    catégories par défaut à la création — voir branches.controller.ts). Les
--    agences existantes sont rattachées via leur valeur `type` actuelle.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS vertical_id UUID REFERENCES branch_verticals(id);

UPDATE branches b
SET vertical_id = v.id
FROM branch_verticals v
WHERE b.vertical_id IS NULL
  AND v.key = COALESCE(b.type, 'other');

CREATE INDEX IF NOT EXISTS idx_branches_vertical ON branches(vertical_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PRODUCTS — code-barres + unité structurée
--    Nécessaires pour le mode supermarché/hypermarché (recherche par scan,
--    vente au poids/volume). Optionnels pour les autres verticals.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS barcode   TEXT,
  ADD COLUMN IF NOT EXISTS unit_type TEXT;

DO $$ BEGIN
  ALTER TABLE products
    ADD CONSTRAINT products_unit_type_check
    CHECK (unit_type IS NULL OR unit_type IN ('piece','kg','g','liter','ml','pack','carton'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_brand_barcode
  ON products(brand_id, barcode) WHERE barcode IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. STOCK_MOVEMENTS — traçabilité de la commande à l'origine d'un décrément
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_order ON stock_movements(order_id);

-- S'assure que la contrainte CHECK sur stock_movements.type autorise bien 'sale'
-- (déjà anticipé côté frontend dans branch/stock/page.tsx, mais pas garanti côté
-- base puisque cette table n'a jamais été versionnée dans une migration du repo).
DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  SELECT con.conname INTO v_constraint_name
  FROM pg_constraint con
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.conrelid = 'stock_movements'::regclass
    AND con.contype = 'c'
    AND att.attname = 'type';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  ALTER TABLE stock_movements
    ADD CONSTRAINT stock_movements_type_check
    CHECK (type IN ('restock','adjustment','removal','loss','sale'));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RPC : reserve_platform_stock
--    Décrémente atomiquement le stock plateforme (branch_stock) à la création
--    d'une commande. Tout ou rien : si un seul article manque, aucune ligne
--    n'est touchée. Les produits sans ligne branch_stock ne sont pas suivis
--    (compatibilité avec les agences qui n'utilisent pas encore le stock).
--
--    p_items : JSONB de la forme '[{"product_id":"...","quantity":2}, ...]'
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reserve_platform_stock(
  p_branch_id UUID,
  p_order_id  UUID,
  p_items     JSONB
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_item          JSONB;
  v_product_id    UUID;
  v_quantity      INTEGER;
  v_row           branch_stock%ROWTYPE;
  v_missing       TEXT := '';
  v_to_decrement  UUID[] := ARRAY[]::UUID[];
  v_qty_map       JSONB := '{}'::JSONB;
BEGIN
  -- Passe 1 : verrouiller les lignes concernées et vérifier la disponibilité
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity   := (v_item->>'quantity')::INTEGER;

    SELECT * INTO v_row
    FROM branch_stock
    WHERE branch_id = p_branch_id AND product_id = v_product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE; -- produit non suivi en stock, on l'ignore
    END IF;

    IF v_row.stock_qty < v_quantity THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ',' END || v_product_id::TEXT;
    ELSE
      v_to_decrement := array_append(v_to_decrement, v_product_id);
      v_qty_map := jsonb_set(v_qty_map, ARRAY[v_product_id::TEXT], to_jsonb(v_quantity));
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK: %', v_missing;
  END IF;

  -- Passe 2 : décrémenter + tracer le mouvement
  FOR v_product_id IN SELECT unnest(v_to_decrement)
  LOOP
    v_quantity := (v_qty_map->>v_product_id::TEXT)::INTEGER;

    UPDATE branch_stock
      SET stock_qty  = stock_qty - v_quantity,
          updated_at = NOW()
    WHERE branch_id = p_branch_id AND product_id = v_product_id
    RETURNING * INTO v_row;

    INSERT INTO stock_movements (
      branch_id, product_id, order_id, type,
      quantity_change, quantity_before, quantity_after
    ) VALUES (
      p_branch_id, v_product_id, p_order_id, 'sale',
      -v_quantity, v_row.stock_qty + v_quantity, v_row.stock_qty
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION reserve_platform_stock(UUID, UUID, JSONB) IS
  'Décrémente atomiquement branch_stock pour les articles d''une commande. '
  'Tout ou rien : lève INSUFFICIENT_STOCK si un article suivi n''a pas assez de stock alloué à la plateforme. '
  'Les produits sans ligne branch_stock ne sont pas suivis et n''empêchent pas la commande.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS : activer sur la nouvelle table
--    L'accès passe uniquement par le service_role côté backend, comme le reste
--    du schéma (voir migration 018).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE branch_verticals ENABLE ROW LEVEL SECURITY;
