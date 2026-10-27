import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Deployment (read at build time, see deploy/frontend/Dockerfile):
 *   AEROLAB_STANDALONE=1           build a self-contained server (.next/standalone) for a container
 *   AEROLAB_BACKEND_INTERNAL_URL   forward /api/* to the backend at this address, so the page and the API
 *                                  share one origin and the session cookie is first-party
 * Neither is set for local development, where the page talks to the backend directly.
 */
const backend = process.env.AEROLAB_BACKEND_INTERNAL_URL?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // three.js ships untranspiled ESM examples used by drei.
  transpilePackages: ["three"],
  // Pin the workspace root to this folder; otherwise a lockfile higher up the tree is picked up.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  output: process.env.AEROLAB_STANDALONE ? "standalone" : undefined,
  // Uploading a wrapped surface and generating a CFD case can take minutes through the forwarding.
  experimental: backend ? { proxyTimeout: 300_000 } : undefined,
  async rewrites() {
    // After the app's own files and routes, so /api/local-models stays the frontend's.
    return backend ? { beforeFiles: [], afterFiles: [{ source: "/api/:path*", destination: `${backend}/api/:path*` }], fallback: [] } : [];
  },
};

export default nextConfig;
