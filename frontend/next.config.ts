import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Enable React Compiler for automatic memoization
  reactCompiler: true,

  // Skip TypeScript errors during build (use separate tsc check)
  typescript: {
    ignoreBuildErrors: true,
  },

  reactStrictMode: true,

  // Server-only packages excluded from bundling (avoid Turbopack conflicts)
  serverExternalPackages: ['fakenet-signer', 'bitcoin-core'],

  // Optimize package imports
  experimental: {
    optimizePackageImports: [
      '@solana/web3.js',
      '@coral-xyz/anchor',
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@tanstack/react-query',
      '@web3icons/react',
    ],
  },
};

export default nextConfig;
