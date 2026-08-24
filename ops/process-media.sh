#!/usr/bin/env bash
#
# Traitement des médias en attente : variantes WebP/AVIF/JPEG (§7).
#
#   ops/process-media.sh [--dry-run]
#
# Codes de sortie : 0 succès (y compris « rien à traiter »), 1 échec.
JOB_NAME=process-media
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

status=0
"$NODE" db/jobs/process-media.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] || job_die "le job des médias a renvoyé le code ${status}."

pending="$(job_json_field "$summary" pending)"
backlog="$(job_json_field "$summary" backlog)"
processed="$(job_json_field "$summary" processed)"
failed="$(job_json_field "$summary" failed)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${pending:-0} média(s) seraient traités · ${backlog:-0} en file."
  exit 0
fi

job_log "terminé · ${processed:-0} traité(s) · ${failed:-0} échec(s) · file initiale ${backlog:-0}."
