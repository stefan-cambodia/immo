#!/usr/bin/env bash
#
# Sauvegarde de la base : dump vérifié, chiffré, copié hors site, rotation.
#
#   ops/backup-db.sh [--dry-run] [--keep N]
#
# Codes de sortie : 0 succès, 1 échec (aucune sauvegarde non vérifiée
# n'est conservée comme si elle valait quelque chose).
JOB_NAME=backup-db
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE} · pg_dump=${BACKUP_PG_DUMP:-pg_dump} · conservées=${BACKUP_KEEP:-14}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

status=0
"$NODE" db/jobs/backup-db.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

if [[ $status -ne 0 ]]; then
  error="$(job_json_field "$summary" error)"
  job_die "la sauvegarde a échoué (${error:-code $status})."
fi

file="$(job_json_field "$summary" file)"
tables="$(job_json_field "$summary" tables)"
encrypted="$(job_json_field "$summary" encrypted)"
offsite="$(job_json_field "$summary" offsite)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${file} serait produit."
  exit 0
fi

[[ "$encrypted" == "true" ]] || job_log "AVERTISSEMENT : sauvegarde en clair (ARCHIVE_KEY absente)."
job_log "terminé · ${file} · ${tables} tables${offsite:+ · hors site ${offsite}}."
