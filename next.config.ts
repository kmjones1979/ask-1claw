import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Launches Chromium and holds a long-lived CDP socket — keep these out of the bundle.
  serverExternalPackages: ["@1claw/browser-bridge", "@1claw/browser-bridge-protocol", "puppeteer-core", "ws"],
};

export default nextConfig;
