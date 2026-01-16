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

  // Configure module transpilation
  transpilePackages: [
    '@solana/wallet-adapter-react',
    '@solana/wallet-adapter-react-ui',
    '@solana/wallet-adapter-base',
    '@solana/wallet-adapter-wallets',
  ],

  // Turbopack configuration (top-level in Next.js 16)
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },

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
