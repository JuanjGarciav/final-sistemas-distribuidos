#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="node-crud-app:latest"

echo "==> [1/6] Verificando estado de Minikube..."
if ! minikube status >/dev/null 2>&1; then
  echo "Minikube no esta activo. Iniciando cluster con driver docker..."
  minikube start --driver=docker --cpus=2 --memory=4096
fi

echo "==> [2/6] Habilitando addons obligatorios (metrics-server e ingress)..."
minikube addons enable metrics-server
minikube addons enable ingress

RUNTIME="$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.containerRuntimeVersion}' 2>/dev/null || echo 'containerd')"

if [[ "${RUNTIME}" == docker://* ]]; then
  echo "==> [3/6] Apuntando daemon de Docker al entorno interno de Minikube..."
  eval "$(minikube docker-env)"

  echo "==> [4/6] Construyendo imagen Docker (${IMAGE_NAME}) dentro de Minikube..."
  docker build -t "${IMAGE_NAME}" "${ROOT_DIR}/app"
else
  echo "==> [3/6] Runtime detectado: ${RUNTIME}. Construyendo imagen Docker (${IMAGE_NAME}) en el host..."
  docker build -t "${IMAGE_NAME}" "${ROOT_DIR}/app"

  echo "==> [4/6] Cargando imagen (${IMAGE_NAME}) en el registro interno de Minikube..."
  minikube image load "${IMAGE_NAME}"
fi

echo "==> [5/6] Aplicando manifiestos de Kubernetes en orden..."
kubectl apply -f "${ROOT_DIR}/k8s/01-db-secret.yaml"
kubectl apply -f "${ROOT_DIR}/k8s/03-db-service.yaml"
kubectl apply -f "${ROOT_DIR}/k8s/02-db-statefulset.yaml"

echo "    Esperando a que el StatefulSet de PostgreSQL este listo..."
kubectl rollout status statefulset/postgres --timeout=180s

kubectl apply -f "${ROOT_DIR}/k8s/04-web-deployment.yaml"
kubectl apply -f "${ROOT_DIR}/k8s/05-web-service.yaml"
kubectl apply -f "${ROOT_DIR}/k8s/06-web-hpa.yaml"
kubectl apply -f "${ROOT_DIR}/k8s/07-ingress.yaml"

echo "    Esperando a que el Deployment de la aplicacion web este listo..."
kubectl rollout status deployment/node-crud-web --timeout=180s

echo "==> [6/6] Resumen del despliegue:"
kubectl get pods,svc,statefulset,pvc,hpa,ingress

cat <<'EOF'

========================================================================
DESPLIEGUE COMPLETADO CON EXITO
========================================================================
Siguientes pasos para exponer LoadBalancer e Ingress en tu host local:

1. En una terminal dedicada, inicia el tunel de Minikube (requiere sudo):
   minikube tunnel

2. Para acceder por dominio mediante Ingress (inventario.local), agrega
   una sola vez esta linea en /etc/hosts:
   echo "127.0.0.1 inventario.local" | sudo tee -a /etc/hosts

3. Abre en el navegador:
   - Via LoadBalancer: http://127.0.0.1  (o la EXTERNAL-IP de 'kubectl get svc node-crud-service')
   - Via Ingress:      http://inventario.local

4. Ejecuta la prueba de estres de memoria para validar el HPA:
   ./scripts/memory_stress.sh
========================================================================
EOF
