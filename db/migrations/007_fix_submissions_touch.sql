-- Correctif : `submissions` avait hérité du déclencheur des biens, qui écrit
-- `dedup_signature` — une colonne qu'elle n'a pas. L'INSERT passait, l'UPDATE
-- échouait. Un déclencheur d'horodatage générique remplace l'emprunt.

DROP TRIGGER IF EXISTS submissions_touch ON submissions;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER submissions_touch
  BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
