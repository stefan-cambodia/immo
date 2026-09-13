-- =====================================================================
-- Les décisions sur les prix invraisemblables entrent au journal d'audit.
--
-- « Prix faux » retire une annonce du catalogue : c'est exactement le
-- genre de décision qu'une agence viendra contester, et le journal doit
-- pouvoir dire qui l'a prise, quand, et sur quel écart. « Prix correct »
-- y figure aussi — savoir qu'un cas a été regardé et validé vaut autant
-- que savoir qu'il a été retiré.
-- =====================================================================

ALTER TYPE audit_action ADD VALUE 'price_confirmed';
ALTER TYPE audit_action ADD VALUE 'price_rejected';
ALTER TYPE audit_target ADD VALUE 'price_review';
