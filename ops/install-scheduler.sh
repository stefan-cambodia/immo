#!/usr/bin/env bash
#
# Installe l'ordonnancement des tâches planifiées.
#
#   ops/install-scheduler.sh [--user immo] [--root /opt/cambodia-immo]
#                            [--web] [--cron] [--dry-run] [--status]
#
# Par défaut : unités systemd (modèle + six timers) copiées dans
# /etc/systemd/system, `daemon-reload`, timers activés et démarrés.
# --web installe et active aussi le serveur (cambodia-immo-web.service).
# --cron écrit /etc/cron.d/cambodia-immo à la place. --dry-run montre les
# fichiers rendus sans rien écrire. --status affiche l'état des timers.
#
# Le script ne devine ni l'utilisateur ni le chemin : ils sont explicites,
# et il refuse un utilisateur qui n'existe pas.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="$ROOT"
APP_USER="${SUDO_USER:-$(id -un)}"
MODE=systemd
DRY=0
WEB=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) APP_USER="$2"; shift 2 ;;
    --root) APP_ROOT="$(cd -- "$2" && pwd)"; shift 2 ;;
    --cron) MODE=cron; shift ;;
    --web) WEB=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --status)
      systemctl list-timers --all 'cambodia-immo-*' 2>/dev/null \
        || echo "systemd indisponible ; voir /etc/cron.d/cambodia-immo."
      systemctl is-active cambodia-immo-web >/dev/null 2>&1 \
        && echo "serveur web : actif" || echo "serveur web : inactif ou non installé"
      exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

id -u "$APP_USER" >/dev/null 2>&1 || { echo "utilisateur inconnu : $APP_USER" >&2; exit 2; }
[[ -x "$APP_ROOT/ops/send-alerts.sh" ]] || { echo "$APP_ROOT ne contient pas ops/" >&2; exit 2; }

render() { sed -e "s#__APP_ROOT__#${APP_ROOT}#g" -e "s#__APP_USER__#${APP_USER}#g" "$1"; }

install_file() { # source, destination
  if [[ $DRY -eq 1 ]]; then
    echo "----- $2"; render "$1"; return
  fi
  render "$1" | install -m 0644 -o root -g root /dev/stdin "$2"
  echo "écrit : $2"
}

if [[ $MODE == cron ]]; then
  install_file "$ROOT/ops/cron.d/cambodia-immo" /etc/cron.d/cambodia-immo
  exit 0
fi

command -v systemctl >/dev/null 2>&1 || { echo "systemctl introuvable : utilisez --cron." >&2; exit 2; }

install_file "$ROOT/ops/systemd/cambodia-immo@.service" /etc/systemd/system/cambodia-immo@.service
timers=()
for f in "$ROOT"/ops/systemd/cambodia-immo-*.timer; do
  name="$(basename "$f")"
  install_file "$f" "/etc/systemd/system/$name"
  timers+=("$name")
done

units=()
if [[ $WEB -eq 1 ]]; then
  [[ -x "$APP_ROOT/node_modules/.bin/next" ]] \
    || echo "note : ${APP_ROOT}/node_modules/.bin/next absent — lancer npm ci puis npm run build avant de démarrer." >&2
  install_file "$ROOT/ops/systemd/cambodia-immo-web.service" /etc/systemd/system/cambodia-immo-web.service
  units+=(cambodia-immo-web.service)
fi

[[ $DRY -eq 1 ]] && exit 0

# Le fichier d'environnement n'est jamais créé ici : il contient des secrets
# et se pose à la main (root:APP_USER, 0640).
[[ -f /etc/cambodia-immo/env ]] \
  || echo "note : /etc/cambodia-immo/env absent — le socle lira ${APP_ROOT}/.env.local." >&2

systemctl daemon-reload
systemctl enable --now "${timers[@]}" "${units[@]}"
systemctl list-timers --all 'cambodia-immo-*'
