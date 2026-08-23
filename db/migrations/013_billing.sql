-- =====================================================================
-- Abonnements agences, quotas et mise en avant payante (phase 3 — §8).
--
-- Le modèle de revenu n°1 du portail : des paliers par nombre d'annonces
-- actives. Pas de paiement en ligne à ce stade — au Cambodge la facture se
-- règle par virement ABA ou en agence ; le portail émet donc des factures
-- mensuelles et la modération les pointe payées à la main. La mécanique qui
-- compte est ailleurs : le quota est appliqué au moment où une annonce
-- devient active, quel que soit le canal d'ingestion.
--
-- Trois décisions structurantes :
--
-- 1. `plans` porte les valeurs par défaut d'un palier ; `agencies` garde ses
--    colonnes `listing_quota` / `featured_quota` comme valeurs EFFECTIVES.
--    Un accord commercial sur mesure (quota négocié) est un simple UPDATE de
--    l'agence, sans palier fantôme dans la table des plans.
--
-- 2. Une annonce au-delà du quota n'est pas refusée : elle est RETENUE
--    (status = 'pending'). Refuser détruirait la donnée qu'une agence vient
--    d'envoyer par flux ou par bot ; retenir la garde prête à publier dès que
--    l'agence libère une place ou monte de palier. `pending` prend ici son
--    sens définitif : « retenue par le quota ».
--
-- 3. La facture est un document comptable : numérotée, immuable dans ses
--    montants, jamais supprimée — une erreur s'annule (status 'void') et se
--    réémet. Le pointage d'un paiement passe par le journal d'audit comme
--    toute action de modération.
-- =====================================================================

-- ------------------------------------------------------------- Paliers
CREATE TABLE plans (
  tier             subscription_tier PRIMARY KEY,
  price_usd_month  numeric(10,2) NOT NULL CHECK (price_usd_month >= 0),
  listing_quota    integer NOT NULL CHECK (listing_quota > 0),
  featured_slots   integer NOT NULL CHECK (featured_slots >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Tarifs de lancement. Ordres de grandeur du marché local : un agent gagne
-- ~300 $/mois, une agence structurée en dépense 10× en marketing.
INSERT INTO plans(tier, price_usd_month, listing_quota, featured_slots) VALUES
  ('free',     0,   20,  0),
  ('standard', 49,  120, 3),
  ('premium',  129, 400, 10);

-- Quota de mises en avant effectif, sur le modèle de `listing_quota` :
-- initialisé depuis le palier, ajustable au cas par cas.
ALTER TABLE agencies ADD COLUMN featured_quota integer NOT NULL DEFAULT 0;
UPDATE agencies a SET featured_quota = p.featured_slots
FROM plans p WHERE p.tier = a.subscription_tier;

-- ------------------------------------------------- Mise en avant payante
-- Une mise en avant est un achat À DURÉE LIMITÉE, pas un attribut permanent :
-- sans échéance, le carrousel d'accueil se fige sur les premières annonces
-- vendues et le produit perd sa valeur pour les acheteurs suivants.
ALTER TABLE listings ADD COLUMN featured_until timestamptz;
UPDATE listings SET featured_until = expires_at WHERE featured;
ALTER TABLE listings ADD CONSTRAINT listings_featured_has_until
  CHECK (NOT featured OR featured_until IS NOT NULL);

CREATE INDEX listings_featured_idx ON listings(featured_until) WHERE featured;

-- ------------------------------------------------------------- Factures
CREATE TYPE invoice_status AS ENUM ('issued', 'paid', 'void');

CREATE SEQUENCE invoice_number_seq;

-- Numérotation lisible et strictement croissante : FAC-2026-00042. La
-- séquence ne se remet pas à zéro au changement d'année — un trou dans la
-- numérotation est acceptable, un doublon jamais.
CREATE FUNCTION next_invoice_number() RETURNS text LANGUAGE sql AS $$
  SELECT 'FAC-' || to_char(now(), 'YYYY') || '-'
         || lpad(nextval('invoice_number_seq')::text, 5, '0')
$$;

CREATE TABLE invoices (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id    uuid NOT NULL REFERENCES agencies(id),
  -- Instantanés dénormalisés, comme dans le journal d'audit : la facture
  -- doit rester lisible même si l'agence change de nom ou de palier.
  agency_name  text NOT NULL,
  number       text NOT NULL UNIQUE DEFAULT next_invoice_number(),
  tier         subscription_tier NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  amount_usd   numeric(10,2) NOT NULL CHECK (amount_usd > 0),
  status       invoice_status NOT NULL DEFAULT 'issued',
  issued_at    timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,
  paid_at      timestamptz,
  -- Référence du règlement (numéro de virement, reçu) saisie au pointage.
  paid_note    text,
  CONSTRAINT invoices_period CHECK (period_end > period_start),
  CONSTRAINT invoices_paid_consistent CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

-- Une seule facture vivante par agence et par période : la génération
-- mensuelle est idempotente, et une facture annulée peut être réémise.
CREATE UNIQUE INDEX invoices_one_per_period
  ON invoices(agency_id, period_start) WHERE status <> 'void';

CREATE INDEX invoices_agency_idx ON invoices(agency_id, period_start DESC);
CREATE INDEX invoices_open_idx   ON invoices(due_at) WHERE status = 'issued';

-- ------------------------------------------------------ Journal d'audit
-- Changer un palier, émettre ou pointer une facture, vendre une mise en
-- avant : autant d'actions qui engagent de l'argent, donc autant d'entrées.
ALTER TYPE audit_action ADD VALUE 'tier_changed';
ALTER TYPE audit_action ADD VALUE 'invoice_issued';
ALTER TYPE audit_action ADD VALUE 'invoice_paid';
ALTER TYPE audit_action ADD VALUE 'invoice_voided';
ALTER TYPE audit_action ADD VALUE 'listing_featured';
ALTER TYPE audit_action ADD VALUE 'listing_unfeatured';

ALTER TYPE audit_target ADD VALUE 'agency';
ALTER TYPE audit_target ADD VALUE 'invoice';
