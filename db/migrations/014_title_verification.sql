-- =====================================================================
-- Vérification documentaire des titres en partenariat (phase 4).
--
-- Le glossaire du brief le dit : hard title sûr et bancable, soft title
-- « moins sûr juridiquement », strata seul régime ouvert aux étrangers.
-- Or le type de titre affiché n'est que déclaratif — c'est l'agent qui
-- l'a saisi. Ici, un partenaire (cabinet juridique, agent cadastral)
-- examine les documents réels du bien et conclut. Le portail n'émet
-- aucun avis juridique lui-même : il consigne la conclusion d'un
-- partenaire nommé, datée, et l'affiche publiquement.
--
-- Trois décisions structurantes :
--
-- 1. Un DOSSIER par examen, jamais un simple booléen sur le bien. Le
--    dossier garde des instantanés (référence, nom du partenaire, titre
--    déclaré au moment de la demande) : comme une facture, il doit
--    rester lisible après coup, même si le bien ou le partenaire change.
--
-- 2. La conclusion du partenaire CORRIGE le bien. Si l'examen conclut à
--    un soft title là où l'agent déclarait un hard title, `title_type`
--    est mis à jour — et `foreign_eligible`, colonne générée, se
--    recalcule seul. Un badge qui contredirait la fiche ne vaudrait rien.
--
-- 3. La conclusion la plus récente fait foi. Un dossier rejeté retire le
--    badge d'une confirmation antérieure : afficher « titre vérifié »
--    quand le dernier examen ne conclut pas serait pire que ne rien
--    afficher.
-- =====================================================================

-- ---------------------------------------------------------- Partenaires
CREATE TABLE verification_partners (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  contact    text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- Dossiers
-- demandé → documents reçus → en examen → confirmé | rejeté.
-- Le rejet est possible à tout stade (documents jamais fournis, dossier
-- abandonné) ; la confirmation exige d'avoir au moins reçu les documents.
CREATE TYPE title_verification_status AS ENUM
  ('requested', 'documents_received', 'in_review', 'confirmed', 'rejected');

CREATE TABLE title_verifications (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  partner_id            uuid NOT NULL REFERENCES verification_partners(id),
  -- Instantanés figés à l'ouverture, sur le modèle des factures.
  property_reference    text NOT NULL,
  partner_name          text NOT NULL,
  claimed_title         title_type NOT NULL,
  status                title_verification_status NOT NULL DEFAULT 'requested',
  requested_by          text NOT NULL,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  documents_received_at timestamptz,
  concluded_at          timestamptz,
  -- Ce que le partenaire a établi, rempli uniquement à la confirmation.
  confirmed_title       title_type,
  note                  text,
  CONSTRAINT title_verif_confirmed CHECK
    (status <> 'confirmed' OR (confirmed_title IS NOT NULL AND concluded_at IS NOT NULL)),
  CONSTRAINT title_verif_rejected CHECK
    (status <> 'rejected' OR concluded_at IS NOT NULL)
);

-- Un seul dossier ouvert par bien : deux examens parallèles du même titre
-- ne peuvent que se contredire.
CREATE UNIQUE INDEX title_verifications_one_open
  ON title_verifications(property_id)
  WHERE status IN ('requested', 'documents_received', 'in_review');

CREATE INDEX title_verifications_property_idx
  ON title_verifications(property_id, requested_at DESC);

-- ------------------------------------------------- Badge public du bien
-- Dénormalisé sur le bien, comme `featured` sur l'annonce : la fiche et
-- les listes n'ont pas à rejoindre les dossiers pour afficher le badge.
ALTER TABLE properties ADD COLUMN title_verified_at timestamptz;
ALTER TABLE properties ADD COLUMN title_verified_by text;

-- ------------------------------------------------------ Journal d'audit
-- Le badge engage la confiance des visiteurs ET la responsabilité du
-- partenaire nommé : chaque étape du dossier est journalisée.
ALTER TYPE audit_action ADD VALUE 'title_verification_requested';
ALTER TYPE audit_action ADD VALUE 'title_verification_step';
ALTER TYPE audit_action ADD VALUE 'title_verification_concluded';

ALTER TYPE audit_target ADD VALUE 'title_verification';
