#!/usr/bin/env bash
#
# Rétention du journal d'audit : archive, purge, puis vérifie.
#
# La vérification fait partie de la tâche, pas d'une discipline d'exploitation :
# sans elle, l'entrée `audit_purged` n'est qu'une affirmation.
#
#   ops/audit-retention.sh [--dry-run] [--days N]
#
# Codes de sortie : 0 succès (y compris « rien à faire »), 1 échec.
JOB_NAME=audit-retention
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

export AUDIT_ACTOR="${AUDIT_ACTOR:-$JOB_ACTOR}"

job_log "démarrage · node=${NODE} · rétention=${AUDIT_RETENTION_DAYS:-730}j · acteur=${AUDIT_ACTOR}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

# `cmd || status=$?` plutôt que `set +e` : sous bash, le trap ERR se déclenche
# même errexit désactivé, et masquerait ce message par un « interrompu ligne N ».
# Dans une liste ||, ni errexit ni le trap ne s'appliquent.
status=0
"$NODE" db/jobs/audit-retention.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] \
  || job_die "le job de rétention a renvoyé le code ${status} (aucune entrée supprimée sans archive valide)."

candidates="$(job_json_field "$summary" candidates)"
purged="$(job_json_field "$summary" purged)"
archive="$(job_json_field "$summary" archive)"

if [[ -z "$archive" ]]; then
  job_log "terminé · ${candidates:-0} entrée(s) hors rétention, aucune archive produite."
  exit 0
fi

job_log "archivé ${purged} entrée(s) dans ${archive}"

# La purge est faite : si l'archive ne correspond pas, il est trop tard pour
# l'annuler, mais l'anomalie doit être bruyante et datée.
if "$NODE" db/jobs/audit-verify.mjs "$archive" >>"$JOB_LOG" 2>&1; then
  job_log "vérification de l'archive : conforme."
else
  job_die "ARCHIVE NON CONFORME après purge — ${archive}. À instruire immédiatement."
fi

job_log "terminé · ${purged} entrée(s) purgée(s) et archivées."
