#!/usr/bin/env bash
#
# Envoi des alertes sur critères sauvegardés (phase 3).
#
#   ops/send-alerts.sh [--dry-run]
#
# À planifier toutes les 15 minutes : les alertes « dès que possible » en
# dépendent, les quotidiennes portent leur propre cadence.
# Codes de sortie : 0 succès (y compris « rien à envoyer »), 1 échec.
JOB_NAME=send-alerts
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

status=0
"$NODE" db/jobs/send-alerts.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] || job_die "le job d'alertes a renvoyé le code ${status}."

due="$(job_json_field "$summary" due)"
sent="$(job_json_field "$summary" sent)"
props="$(job_json_field "$summary" properties)"
skipped="$(job_json_field "$summary" skipped)"
purged="$(job_json_field "$summary" purged)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${due:-0} alerte(s) partiraient."
  exit 0
fi

job_log "terminé · ${sent:-0} alerte(s) envoyée(s) (${props:-0} biens) · ${skipped:-0} reportée(s) · ${purged:-0} inscription(s) non confirmée(s) purgée(s)."
