import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The `postgres` driver is a native-ish dependency that should not be
  // bundled into server components output.
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
