import { createConfig, http } from 'wagmi';
import { sepolia } from 'wagmi/chains';

import { getAlchemyEthSepoliaRpcUrl } from '@/lib/rpc';

export const wagmiConfig = createConfig({
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(getAlchemyEthSepoliaRpcUrl()),
  },
});
