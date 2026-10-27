# AeroLab backend: FastAPI and OpenFOAM in one image. Built from the repository root:
#
#     fly deploy . --config deploy/backend/fly.toml
#
# OpenFOAM comes from the official openfoam.com image (Ubuntu 24.04), Python 3.12 from Ubuntu's packages
# and uv from PyPI, so the build downloads nothing from GitHub.

FROM opencfd/openfoam-default:2512

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Let MPI start as many processes as the machine has virtual CPUs (hardware threads count as cores).
    OMPI_MCA_hwloc_base_use_hwthreads_as_cpus=1 \
    OMPI_MCA_rmaps_base_oversubscribe=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/uv \
    && /opt/uv/bin/pip install --no-cache-dir uv==0.10.6 \
    && ln -s /opt/uv/bin/uv /usr/local/bin/uv

WORKDIR /app/backend
# Dependencies first, so a code change does not reinstall them.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --python /usr/bin/python3

COPY shared /app/shared
COPY backend /app/backend
COPY deploy/backend/entrypoint.sh /usr/local/bin/aerolab-backend
COPY deploy/backend/serve.py /usr/local/lib/aerolab/serve.py
RUN chmod 755 /usr/local/bin/aerolab-backend \
    && useradd --create-home --shell /bin/bash aerolab \
    && mkdir -p /app/backend/data \
    && chown aerolab:aerolab /app/backend/data

EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/aerolab-backend"]
