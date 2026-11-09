/** @type {import('next').NextConfig} */
const feralApi = process.env.FERAL_API_URL ?? 'http://127.0.0.1:8787';

const nextConfig = {
  outputFileTracingRoot: __dirname,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${feralApi}/api/:path*` }];
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
