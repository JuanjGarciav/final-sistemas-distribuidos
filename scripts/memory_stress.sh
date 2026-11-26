#!/usr/bin/env bash
set -euo pipefail

TARGET_URL=""
MB_PER_REQ=40
TTL_SECONDS=210
TOTAL_REQUESTS=70
INTERVAL_SECONDS=2
RELEASE_MODE=false

usage() {
  cat <<'EOF'
Uso: ./scripts/memory_stress.sh [opciones]

Opciones:
  --url <URL>         URL base de la app (ej. http://127.0.0.1:8080 o http://inventario.local)
  --mb <N>            Megabytes a reservar por peticion (default: 40)
  --ttl <SEGUNDOS>    Tiempo de retencion de memoria en segundos (default: 210)
  --requests <N>      Cantidad total de peticiones a enviar (default: 70)
  --interval <SEG>    Pausa entre peticiones en segundos (default: 2)
  --release           Libera los buffers de memoria en los Pods en lugar de reservarlos
  -h, --help          Muestra esta ayuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      TARGET_URL="$2"
      shift 2
      ;;
    --mb)
      MB_PER_REQ="$2"
      shift 2
      ;;
    --ttl)
      TTL_SECONDS="$2"
      shift 2
      ;;
    --requests)
      TOTAL_REQUESTS="$2"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --release)
      RELEASE_MODE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Opcion no reconocida: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Auto-detect LoadBalancer EXTERNAL-IP if --url was not provided
if [[ -z "${TARGET_URL}" ]]; then
  if command -v kubectl >/dev/null 2>&1; then
    LB_IP="$(kubectl get svc node-crud-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    LB_PORT="$(kubectl get svc node-crud-service -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)"
    if [[ -n "${LB_IP}" ]]; then
      TARGET_URL="http://${LB_IP}:${LB_PORT:-8080}"
    fi
  fi
fi

if [[ -z "${TARGET_URL}" ]]; then
  TARGET_URL="http://127.0.0.1:8080"
fi

TARGET_URL="${TARGET_URL%/}"

if [[ "${RELEASE_MODE}" == "true" ]]; then
  echo "==> Liberando memoria reservada en ${TARGET_URL}/stress-memory?release=true ..."
  for i in $(seq 1 15); do
    RESPONSE="$(curl -sS --max-time 5 "${TARGET_URL}/stress-memory?release=true" || echo '{"error":"sin respuesta"}')"
    printf "[%02d/15] %s\n" "${i}" "${RESPONSE}"
    sleep 0.5
  done
  echo "==> Solicitudes de liberacion enviadas. Observa el escalado hacia abajo con: kubectl get hpa -w"
  exit 0
fi

echo "========================================================================"
echo "PRUEBA DE CARGA DE MEMORIA PARA HPA (METRICA: MEMORY UTILIZATION 70%)"
echo "========================================================================"
echo "Destino:     ${TARGET_URL}/stress-memory?mb=${MB_PER_REQ}&ttl=${TTL_SECONDS}"
echo "Peticiones:  ${TOTAL_REQUESTS} (cada ${INTERVAL_SECONDS}s)"
echo ""
echo "TIP: Abre dos terminales paralelas antes o durante esta ejecucion:"
echo "  Terminal A: kubectl get hpa -w"
echo "  Terminal B: kubectl get pods -l app=node-crud-web -w"
echo "========================================================================"
echo ""

for i in $(seq 1 "${TOTAL_REQUESTS}"); do
  RESPONSE="$(curl -sS --max-time 5 "${TARGET_URL}/stress-memory?mb=${MB_PER_REQ}&ttl=${TTL_SECONDS}" || echo '{"error":"peticion fallida - verifica minikube tunnel"}')"
  printf "[%02d/%02d] %s\n" "${i}" "${TOTAL_REQUESTS}" "${RESPONSE}"
  sleep "${INTERVAL_SECONDS}"
done

echo ""
echo "==> Prueba finalizada. Estado actual de HPA y Pods:"
if command -v kubectl >/dev/null 2>&1; then
  kubectl get hpa node-crud-hpa
  kubectl get pods -l app=node-crud-web -o wide
  kubectl top pods -l app=node-crud-web 2>/dev/null || true
fi
