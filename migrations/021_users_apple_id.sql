-- ============================================================
-- DASH MEAL — Migration 021
-- Colonne apple_id sur users (Apple Sign-In)
-- À exécuter dans l'éditeur SQL Supabase
--
-- auth.service.ts (appleAuth) et users.controller.ts (getMyProfile)
-- référencent déjà apple_id, jamais ajoutée en base — GET /users/me
-- (checkout, profil) et la connexion Apple plantaient en 500.
-- Même définition que google_id (déjà en place).
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS apple_id TEXT UNIQUE;
