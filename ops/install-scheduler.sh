#!/usr/bin/env bash
#
# Installe l'ordonnancement des tâches planifiées.
#
#   ops/install-scheduler.sh [--user immo] [--root /opt/cambodia-immo]
#                            [--scope system|user] [--port 3111]
#                            [--web] [--no-timers] [--cron] [--dry-run] [--status]
#
# Par défaut : unités systemd (modèle + six timers) copiées dans
# /etc/systemd/system, `daemon-reload`, timers activés et démarrés.
# --web installe et active aussi le serveur (cambodia-immo-web.service).
# --no-timers n'installe QUE ce qui est demandé par ailleurs : de quoi poser
# le serveur sur une machine de travail sans y déclencher les sauvegardes,
# la facturation et les envois d'alertes.
# --cron écrit /etc/cron.d/cambodia-immo à la place. --dry-run montre les
# fichiers rendus sans rien écrire. --status affiche l'état des timers.
#
# --scope user installe dans ~/.config/systemd/user et pilote `systemctl
# --user` : c'est le mode d'une machine de travail, où l'on n'est pas root et
# où l'application vit dans le /home. Il active aussi le `linger`, sans quoi
# les unités d'utilisateur s'arrêtent à la déconnexion et ne repartent pas au
# démarrage de la machine.
#
# Le script ne devine ni l'utilisateur ni le chemin : ils sont explicites,
# et il refuse un utilisateur qui n'existe pas.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="$ROOT"
APP_USER="${SUDO_USER:-$(id -un)}"
MODE=systemd
SCOPE=system
DRY=0
WEB=0
TIMERS=1
PORT=3000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) APP_USER="$2"; shift 2 ;;
    --root) APP_ROOT="$(cd -- "$2" && pwd)"; shift 2 ;;
    --cron) MODE=cron; shift ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --web) WEB=1; shift ;;
    --no-timers) TIMERS=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --status)
      for sc in --system --user; do
        systemctl $sc list-timers --all 'cambodia-immo-*' 2>/dev/null | grep -q cambodia \
          && { echo "== ${sc#--} =="; systemctl $sc list-timers --all 'cambodia-immo-*'; }
        systemctl $sc is-active cambodia-immo-web >/dev/null 2>&1 \
          && echo "serveur web (${sc#--}) : actif"
      done
      exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

id -u "$APP_USER" >/dev/null 2>&1 || { echo "utilisateur inconnu : $APP_USER" >&2; exit 2; }
[[ -x "$APP_ROOT/ops/send-alerts.sh" ]] || { echo "$APP_ROOT ne contient pas ops/" >&2; exit 2; }

case "$SCOPE" in
  system|user) ;;
  *) echo "--scope attend system ou user" >&2; exit 2 ;;
esac

if [[ $SCOPE == user ]]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SYSTEMCTL=(systemctl --user)
  mkdir -p "$UNIT_DIR"
else
  UNIT_DIR=/etc/systemd/system
  SYSTEMCTL=(systemctl)
fi

render() {
  sed -e "s#__APP_ROOT__#${APP_ROOT}#g" -e "s#__APP_USER__#${APP_USER}#g" \
      -e "s#__APP_PORT__#${PORT}#g" "$1"
}

install_file() { # source, destination
  if [[ $DRY -eq 1 ]]; then
    echo "----- $2"; render "$1"; return
  fi
  if [[ $SCOPE == user ]]; then
    render "$1" | install -m 0644 /dev/stdin "$2"
  else
    render "$1" | install -m 0644 -o root -g root /dev/stdin "$2"
  fi
  echo "écrit : $2"
}

if [[ $MODE == cron ]]; then
  install_file "$ROOT/ops/cron.d/cambodia-immo" /etc/cron.d/cambodia-immo
  exit 0
fi

command -v systemctl >/dev/null 2>&1 || { echo "systemctl introuvable : utilisez --cron." >&2; exit 2; }

timers=()
if [[ $TIMERS -eq 1 ]]; then
  template="$ROOT/ops/systemd/cambodia-immo@.service"
  [[ $SCOPE == user ]] && template="$ROOT/ops/systemd/user/cambodia-immo@.service"
  install_file "$template" "$UNIT_DIR/cambodia-immo@.service"
  for f in "$ROOT"/ops/systemd/cambodia-immo-*.timer; do
    name="$(basename "$f")"
    install_file "$f" "$UNIT_DIR/$name"
    timers+=("$name")
  done
fi

units=()
if [[ $WEB -eq 1 ]]; then
  [[ -x "$APP_ROOT/node_modules/.bin/next" ]] \
    || echo "note : ${APP_ROOT}/node_modules/.bin/next absent — lancer npm ci puis npm run build avant de démarrer." >&2
  # L'unité de production tourne sous un compte dédié, hors du /home, et se
  # voit refuser l'accès à celui-ci. Une machine de travail a besoin de
  # l'inverse : voir ops/systemd/user/cambodia-immo-web.service.
  if [[ $SCOPE == user ]]; then
    install_file "$ROOT/ops/systemd/user/cambodia-immo-web.service" \
                 "$UNIT_DIR/cambodia-immo-web.service"
  else
    install_file "$ROOT/ops/systemd/cambodia-immo-web.service" \
                 "$UNIT_DIR/cambodia-immo-web.service"
  fi
  units+=(cambodia-immo-web.service)
fi

[[ $DRY -eq 1 ]] && exit 0

# `--no-timers` sans `--web` ne désigne rien : mieux vaut le dire que laisser
# `systemctl enable` échouer sur une liste vide.
if [[ ${#timers[@]} -eq 0 && ${#units[@]} -eq 0 ]]; then
  echo "rien à installer : --no-timers sans --web." >&2
  exit 2
fi

# Le fichier d'environnement n'est jamais créé ici : il contient des secrets
# et se pose à la main (root:APP_USER, 0640).
if [[ $SCOPE == system ]]; then
  [[ -f /etc/cambodia-immo/env ]] \
    || echo "note : /etc/cambodia-immo/env absent — le socle lira ${APP_ROOT}/.env.local." >&2
else
  # Sans `linger`, les unités d'utilisateur s'arrêtent à la déconnexion et ne
  # sont pas démarrées au boot : le service ne survivrait pas au redémarrage,
  # ce qui est précisément ce qu'on installe.
  if [[ "$(loginctl show-user "$APP_USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
    loginctl enable-linger "$APP_USER" \
      || echo "note : loginctl enable-linger ${APP_USER} a échoué — le service ne repartira pas au démarrage." >&2
  fi
fi

"${SYSTEMCTL[@]}" daemon-reload
"${SYSTEMCTL[@]}" enable --now "${timers[@]}" "${units[@]}"
[[ ${#timers[@]} -gt 0 ]] && "${SYSTEMCTL[@]}" list-timers --all 'cambodia-immo-*'
for u in "${units[@]}"; do
  "${SYSTEMCTL[@]}" --no-pager --lines=0 status "$u" | head -3
done
