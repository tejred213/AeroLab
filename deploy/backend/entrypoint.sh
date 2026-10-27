#!/bin/bash
# Starts the AeroLab backend: prepares the data volume, loads the OpenFOAM environment and runs uvicorn as
# an unprivileged user (MPI also refuses to run as root).
set -eo pipefail

DATA=/app/backend/data
# A fresh Fly volume is mounted owned by root.
mkdir -p "$DATA"
chown aerolab:aerolab "$DATA"

# Puts blockMesh, snappyHexMesh, simpleFoam and mpirun on the PATH; the backend then runs them directly.
bashrc=$(ls -d /usr/lib/openfoam/openfoam*/etc/bashrc | sort | tail -n 1)
# OpenFOAM's bashrc ends with a non-zero status even when it worked, so it is loaded without
# exit-on-error and checked by what it provides instead.
set +e
# shellcheck disable=SC1090
source "$bashrc"
set -e
for program in blockMesh snappyHexMesh simpleFoam mpirun; do
    command -v "$program" >/dev/null || { echo "OpenFOAM environment from $bashrc has no $program" >&2; exit 1; }
done

cd /app/backend
# serve.py: one uvicorn process on a socket that takes both IPv6 (private network) and IPv4 (health check).
exec setpriv --reuid=aerolab --regid=aerolab --init-groups -- env HOME=/home/aerolab USER=aerolab \
    /opt/venv/bin/python /usr/local/lib/aerolab/serve.py 8000
