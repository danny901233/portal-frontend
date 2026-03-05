import type { NextConfig } from "next";

import { API_PROXY_PREFIX } from "./app/lib/constants";

const backendOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  async rewrites() {
    return [
      {
        source: `${API_PROXY_PREFIX}/:path*`,
        destination: `${backendOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
