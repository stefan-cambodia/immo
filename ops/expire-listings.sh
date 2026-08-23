#!/usr/bin/env bash
#
# Expiration des annonces à 45 jours (§6.3).
#
#   ops/expire-listings.sh [--dry-run]
#
# Codes de sortie : 0 succès (y compris « rien à expirer »), 1 échec.
JOB_NAME=expire-listings
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

# `cmd || status=$?` plutôt que `set +e` : sous bash, le trap ERR se déclenche
# même errexit désactivé, et masquerait ce message par un « interrompu ligne N ».
# Dans une liste ||, ni errexit ni le trap ne s'appliquent.
status=0
"$NODE" db/jobs/expire-listings.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] || job_die "le job d'expiration a renvoyé le code ${status}."

due="$(job_json_field "$summary" due)"
expired="$(job_json_field "$summary" expired)"
chase="$(job_json_field "$summary" chaseWindow)"
active="$(job_json_field "$summary" activeAfter)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${due:-0} annonce(s) expireraient · ${chase:-0} à relancer sous 7 j."
  exit 0
fi

job_log "terminé · ${expired:-0} annonce(s) expirée(s) · ${active:-0} actives · ${chase:-0} à relancer sous 7 j."
