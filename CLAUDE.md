# CLAUDE.md — dash-meal-backend
> Repo autonome, extrait du monorepo Dash Meal le 2026-08-12. Lire avant de toucher au code.

## Contexte de la migration

Ce repo était `apps/backend` dans un monorepo Turbo/pnpm (`packages/shared`, `apps/admin`, `apps/mobile`). Il a été extrait en repo indépendant pour permettre un déploiement séparé sur **Render** (auparavant Railway). Les fronts (`dash-meal-admin`, `dash-meal-mobile`) sont maintenant dans des repos GitHub séparés eux aussi et communiquent avec ce backend **exclusivement via API HTTP** — ils n'ont plus de code partagé avec lui.

- `packages/shared` (types + schémas Zod du monorepo) a été **fusionné dans `src/shared/`** — ce n'est plus un package séparé. Import interne : `from "../shared/index.js"` (adapter la profondeur relative selon le fichier).
- Sibling repos (pas de code partagé, communication API uniquement) :
  - https://github.com/Ing-Valdes-GL/dash-meal-admin (Next.js, déployé sur Vercel, domaine `dash-meal.com`)
  - https://github.com/Ing-Valdes-GL/dash-meal-mobile (Expo, build via EAS)
- **Historique Git non conservé** lors du split (décision volontaire) — ce repo démarre à son propre commit initial.
- Convention de branches `service/backend|admin|mobile|shared` de l'ancien monorepo **ne s'applique plus ici** : ce repo pousse directement sur `main`.

## Commandes

```bash
pnpm install
pnpm dev          # tsx watch src/app.ts (port 3001)
pnpm build        # tsc → dist/
pnpm start         # node dist/app.js
pnpm typecheck     # tsc --noEmit
```

Pas de Turbo, pas de `--filter` : ce repo est autonome, ces commandes s'exécutent directement à la racine.

## Architecture

**Module pattern** : chaque domaine métier a `module.controller.ts` + `module.routes.ts` + `module.service.ts` sous `src/modules/`. Modules actuels : admins, ads, analytics, audit, auth, branch-auth, branch-hours, branch-managers, branches, brands, cart, chat, collect, commissions, delivery, delivery-zones, documents, driver, driver-docs, driver-wallet, favorites, group-orders, invoices, loyalty, maps, notifications, orders, payments, products, promo-codes, promotions, reports, stock, tracking, user-wallet, users, wallet.

**Middleware stack** (`src/app.ts`) : `helmet` → `cors` → `morgan` → `express-rate-limit` → `express.json` → routes → `errorHandler`.

**Auth middleware** (`src/middleware/auth.ts`) : vérifie le JWT, attache `req.user` avec `{ id, role, brand_id? }`.

**Validation** (`src/middleware/validate.ts`) : wrap les schémas Zod de `src/shared/schemas/`. Utiliser `validate(schema)` avant les handlers de route.

**Réponses standard :**
```typescript
res.json({ success: true, data: T, message?: string })
throw new AppError(statusCode, "ERROR_CODE", "Message humain")
res.json({ success: true, data: T[], pagination: { page, limit, total, total_pages } })
```

**Database** : Supabase (service role key) via `src/config/supabase.ts`. JWT custom, jamais Supabase Auth côté backend.

## Déploiement (Render)

`render.yaml` à la racine configure le build (`pnpm install --frozen-lockfile && pnpm run build`), le start (`pnpm run start`) et le health check (`/api/v1/health`). Les variables marquées `sync: false` doivent être renseignées **manuellement dans le dashboard Render** (Environment) — elles ne sont pas dans `render.yaml` ni dans le code :

```
CORS_ORIGINS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, JWT_REFRESH_SECRET,
AT_API_KEY, AT_USERNAME, AT_SENDER_ID, CAMPAY_APP_USERNAME, CAMPAY_APP_PASSWORD,
CAMPAY_BASE_URL, CAMPAY_CALLBACK_URL, CAMPAY_WEBHOOK_SECRET, GOOGLE_MAPS_API_KEY,
EXPO_ACCESS_TOKEN, RESEND_API_KEY, RESEND_FROM_EMAIL
```

**URL de production actuelle** : `https://dashmeal-3ix5.onrender.com` (API sous `/api/v1`).

**CORS_ORIGINS** doit inclure tous les domaines des fronts qui appellent l'API. Le default dans `src/config/env.ts` n'est utilisé que si la variable n'est PAS définie sur Render — s'il y a une erreur "CORS: origine non autorisée" en prod, c'est la valeur du dashboard Render qu'il faut corriger, pas seulement le code.

**Keep-alive** (`src/services/keepAlive.ts`) : auto-ping `GET /api/v1/health` toutes les 6 à 10 min (délai randomisé), actif **uniquement si `NODE_ENV=production`**, pour éviter la mise en veille du plan gratuit Render. Rien ne tourne en dev local.

## Conventions clés

- **Isolation des rôles** : routes `superadmin` sous `/superadmin/*`, jamais exposées à un `admin` classique. Vérifier `req.user.role`.
- **Isolation par marque** : toute query admin doit filtrer par `brand_id`. Jamais de données cross-brand vers un admin.
- **Devise** : CEMAC (XAF).
- **Paiements** : Mobile Money via Campay. Webhook : `/api/v1/payments/webhook/campay`.
- **Uploads** : Multer → Supabase Storage. Buckets : `product-images`, `brand-documents`, `invoices`, `ad-images`. Max 5MB, JPEG/PNG/WebP.
- **OTP** : Africa's Talking SMS, 6 chiffres, expiration 10 min.
- **Commission** : 2% paiement en ligne, 1.5% en personne (auto-calculée).

## Variables d'environnement locales

`.env.local` (gitignoré) — voir `.env.local.example` pour la liste complète et où obtenir chaque clé.
