"""Runs the backend on one socket that accepts IPv6 and IPv4.

uvicorn --host :: listens on IPv6 only (asyncio marks such sockets IPv6-only). On Fly.io the frontend
reaches the backend over the private IPv6 network while the health check connects over IPv4, so the
socket is opened here with IPV6_V6ONLY off and handed to uvicorn.
"""

from __future__ import annotations

import os
import socket
import sys

import uvicorn

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

listener = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
listener.bind(("::", PORT))

# Run from the backend folder (main.py); one process: jobs live in memory, so a second worker would not see them.
uvicorn.run("main:app", app_dir=os.getcwd(), fd=listener.fileno(), workers=1, access_log=False)
