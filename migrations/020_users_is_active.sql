-- ============================================================
-- DASH MEAL — Migration 020
-- Colonne is_active sur users (support à l'archivage de compte)
-- À exécuter dans l'éditeur SQL Supabase
--
-- users.controller.ts (toggleUserActive) référence déjà is_active
-- sur cette table sans qu'une migration l'ait jamais créée dans ce
-- repo — probablement ajoutée manuellement à un moment donné.
-- IF NOT EXISTS rend cette migration sûre dans les deux cas.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
