-- ============================================================
-- DASH MEAL — Migration 018
-- Tables manquantes + fonctions RPC manquantes
-- À exécuter dans l'éditeur SQL Supabase
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. BRANCH MANAGERS
--    Gestionnaires d'agences (rôle intermédiaire admin → branch_manager)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS branch_managers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID        NOT NULL REFERENCES branches(id)  ON DELETE CASCADE,
  brand_id      UUID        NOT NULL REFERENCES brands(id)    ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  phone         TEXT        NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_managers_branch ON branch_managers(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_managers_brand  ON branch_managers(brand_id);

DO $$ BEGIN
  CREATE TRIGGER branch_managers_updated_at
    BEFORE UPDATE ON branch_managers
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DRIVER WALLETS
--    Wallet de gains pour chaque livreur (70 % de la commission de livraison)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driver_wallets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID        UNIQUE NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  brand_id        UUID        NOT NULL REFERENCES brands(id)         ON DELETE CASCADE,
  balance         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_wallets_driver ON driver_wallets(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_wallets_brand  ON driver_wallets(brand_id);

DO $$ BEGIN
  CREATE TRIGGER driver_wallets_updated_at
    BEFORE UPDATE ON driver_wallets
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DRIVER WALLET TRANSACTIONS
--    Historique des gains et retraits du livreur
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driver_wallet_transactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id        UUID        NOT NULL REFERENCES drivers(id)  ON DELETE CASCADE,
  brand_id         UUID        NOT NULL REFERENCES brands(id)   ON DELETE CASCADE,
  type             TEXT        NOT NULL CHECK (type IN ('earning', 'withdrawal')),
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after    NUMERIC(14,2) NOT NULL,
  description      TEXT        NOT NULL,
  order_id         UUID        REFERENCES orders(id)            ON DELETE SET NULL,
  campay_reference TEXT,
  status           TEXT        NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('pending', 'completed', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dwt_driver_date ON driver_wallet_transactions(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dwt_brand_date  ON driver_wallet_transactions(brand_id,  created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. LOYALTY ACCOUNTS
--    Compte de fidélité par utilisateur (remplace loyalty_points)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points         INTEGER     NOT NULL DEFAULT 0 CHECK (points >= 0),
  total_earned   INTEGER     NOT NULL DEFAULT 0,
  total_redeemed INTEGER     NOT NULL DEFAULT 0,
  level          TEXT        NOT NULL DEFAULT 'bronze'
                 CHECK (level IN ('bronze', 'silver', 'gold')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_accounts_user ON loyalty_accounts(user_id);

DO $$ BEGIN
  CREATE TRIGGER loyalty_accounts_updated_at
    BEFORE UPDATE ON loyalty_accounts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. LOYALTY TRANSACTIONS
--    Historique des points gagnés / dépensés
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  order_id    UUID        REFERENCES orders(id)          ON DELETE SET NULL,
  type        TEXT        NOT NULL CHECK (type IN ('earn', 'redeem')),
  points      INTEGER     NOT NULL CHECK (points > 0),
  description TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_user ON loyalty_transactions(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. GROUP CARTS (commande groupée)
--    Un hôte crée un panier partagé, les membres y ajoutent leurs articles
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_carts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  branch_id  UUID        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  share_code TEXT        NOT NULL UNIQUE,                  -- code 8 car. pour rejoindre
  status     TEXT        NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'locked', 'ordered', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_carts_host   ON group_carts(host_id);
CREATE INDEX IF NOT EXISTS idx_group_carts_branch ON group_carts(branch_id);
CREATE INDEX IF NOT EXISTS idx_group_carts_code   ON group_carts(share_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. GROUP CART MEMBERS
--    Participants d'un panier de groupe
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_cart_members (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_cart_id UUID        NOT NULL REFERENCES group_carts(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  is_host       BOOLEAN     NOT NULL DEFAULT FALSE,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_cart_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_cart_members_cart ON group_cart_members(group_cart_id);
CREATE INDEX IF NOT EXISTS idx_group_cart_members_user ON group_cart_members(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. GROUP CART ITEMS
--    Articles ajoutés par chaque membre dans le panier de groupe
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_cart_items (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_cart_id UUID        NOT NULL REFERENCES group_carts(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  product_id    UUID        NOT NULL REFERENCES products(id)     ON DELETE CASCADE,
  quantity      INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price    NUMERIC(12,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_cart_id, user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_group_cart_items_cart ON group_cart_items(group_cart_id);
CREATE INDEX IF NOT EXISTS idx_group_cart_items_user ON group_cart_items(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. COLONNES MANQUANTES SUR TABLES EXISTANTES
-- ─────────────────────────────────────────────────────────────────────────────

-- orders : driver_fee_paid (référencé dans driver-wallet.controller)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS driver_fee_paid BOOLEAN NOT NULL DEFAULT FALSE;

-- drivers : colonne brand_id si absente (certaines migrations l'ajoutent via ALTER)
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_drivers_brand ON drivers(brand_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. RPC : increment_slot_booking
--     Incrémente le nombre de réservations sur un créneau (avec contrôle capacité)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_slot_booking(slot_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_capacity INTEGER;
  v_booked   INTEGER;
BEGIN
  SELECT capacity, booked INTO v_capacity, v_booked
  FROM time_slots
  WHERE id = slot_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SLOT_NOT_FOUND: Créneau introuvable';
  END IF;

  IF v_booked >= v_capacity THEN
    RAISE EXCEPTION 'SLOT_FULL: Créneau complet (% / %)', v_booked, v_capacity;
  END IF;

  UPDATE time_slots
    SET booked = booked + 1
  WHERE id = slot_id;
END;
$$;

COMMENT ON FUNCTION increment_slot_booking(UUID) IS
  'Incrémente booked sur un créneau. Lève une exception si le créneau est plein.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. RPC : decrement_slot_booking
--     Décrémente le nombre de réservations (annulation commande collect)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION decrement_slot_booking(slot_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE time_slots
    SET booked = GREATEST(0, booked - 1)
  WHERE id = slot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SLOT_NOT_FOUND: Créneau introuvable';
  END IF;
END;
$$;

COMMENT ON FUNCTION decrement_slot_booking(UUID) IS
  'Décrémente booked sur un créneau lors d''une annulation. Ne passe jamais sous 0.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. FK : commissions.brand_id → brands
--     La FK existe déjà dans migration 001. On s'assure que PostgREST la voit
--     en ajoutant un commentaire de relation explicite si besoin.
--     (Si la FK n'existe pas encore dans votre base, décommenter ci-dessous)
-- ─────────────────────────────────────────────────────────────────────────────

-- ALTER TABLE commissions
--   ADD CONSTRAINT IF NOT EXISTS fk_commissions_brand
--   FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. RLS : activer sur les nouvelles tables
--     L'accès passe uniquement par le service_role côté backend.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE branch_managers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_wallets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_carts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_cart_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_cart_items        ENABLE ROW LEVEL SECURITY;

-- Toutes les tables utilisent uniquement service_role (backend Express).
-- Aucune policy publique nécessaire — le RLS bloque par défaut les accès directs.
