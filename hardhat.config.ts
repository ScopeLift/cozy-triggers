import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'solidity-coverage';
import './tasks/accounts';
import './tasks/clean';

import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
import { NetworkUserConfig } from 'hardhat/types';

dotenvConfig({ path: resolve(__dirname, './.env') });

const chainIds = {
  ganache: 1337,
  goerli: 5,
  hardhat: 31337,
  kovan: 42,
  mainnet: 1,
  rinkeby: 4,
  ropsten: 3,
};

// Ensure that we have all the environment variables we need.
const privateKey = process.env.PRIVATE_KEY as string;
if (!privateKey) throw new Error('Please set your PRIVATE_KEY in a .env file');

const rpcUrl = process.env.RPC_URL as string;
if (!rpcUrl) throw new Error('Please set your RPC_URL in a .env file');

// Use the default hardhat mnemonic when on localhost
const mnemonic = 'test test test test test test test test test test test junk';

// Helper function to generate a hardhat network config
function createNetworkConfig(network: keyof typeof chainIds): NetworkUserConfig {
  return {
    accounts: [privateKey],
    chainId: chainIds[network],
    url: rpcUrl,
  };
}

// Main hardhat configuration
const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      accounts: { mnemonic },
      chainId: chainIds.hardhat,
      forking: { url: rpcUrl },
    },
    mainnet: createNetworkConfig('mainnet'),
  },
  paths: {
    artifacts: './artifacts',
    cache: './cache',
    sources: './contracts',
    tests: './test',
  },
  mocha: {
    timeout: 0,
  },
  solidity: {
    version: '0.8.5',
    settings: {
      metadata: {
        // Not including the metadata hash
        // https://github.com/paulrberg/solidity-template/issues/31
        bytecodeHash: 'none',
      },
      // You should disable the optimizer when debugging
      // https://hardhat.org/hardhat-network/#solidity-optimizer-support
      optimizer: {
        enabled: true,
        runs: 999999,
      },
    },
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5',
  },
};

export default config;
