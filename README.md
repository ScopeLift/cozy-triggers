# Cozy Developer Guides

This repository contains various guides to show you how to interact with the Cozy Protocol. These guides assume knowledge of [TypeScript](https://www.typescriptlang.org/), [ethers.js](https://docs.ethers.io/v5/single-page/), and [Solidity](https://docs.soliditylang.org/en/v0.8.3/), as well as familiarity with the [Cozy Protocol](https://app.gitbook.com/@cozy-finance-1/s/cozy-docs/for-developers/technical-overview). [Hardhat](https://hardhat.org/) is used as well, but you shouldn't need to be too familiar with Hardhat to use this repo.

- [Cozy Developer Guides](#cozy-developer-guides)
  - [Getting Started](#getting-started)
  - [Usage](#usage)
  - [Index of Guides](#index-of-guides)

## Getting Started

All scripts in this repository are run against a local fork of the Ethereum mainnet using [Hardhat](https://hardhat.org/), so you can have confidence that if your scripts work in this environment they should also work in production. For more information on running scripts against a forked network, see the [Mainnet Forking](https://hardhat.org/guides/mainnet-forking.html) section of the Hardhat documentation.

First, run `yarn` at the project root to install all dependencies.

Next, copy the `.env.example` file, rename it to `.env`, and set the variables accordingly:

- `RPC_URL` shows an Infura endpoint as the default, but you are free to use any node provider of your choice. Use the full RPC URL as the value for this environment variable
- The `PRIVATE_KEY` will be used to generate the primary account used in scripts, so you can either:
  1. Use a private key corresponding to an account that has ETH on mainnet, or
  2. Use any arbitrary private key and use the `fundAccount()` method of `utils.ts` to supply the account with funds at the beginning of a script (this is what the scripts do by default)

Let's also discuss one important aspect of Cozy: handling failed transactions. As with Compound, just because a transaction was successful does not mean it succeeded in doing what you expected. Cozy inherited some of Compound's error handling approaches, which means a transaction may be successful&mdash;and show as successful on Etherscan and other block explorers&mdash;but in reality it didn't do what you expected. This is because some failed transactions will return an error code and emit a `Failure` event instead of reverting. You can find Compound's error codes [here](https://compound.finance/docs/ctokens#error-codes), and a brief history of why it's handled this way [here](https://www.comp.xyz/t/brief-history-of-error-handling-in-the-protocol/1169).

This approach can be a bit tedious for user's and developers, as we now we have to manually ensure our transaction succeeded before continuing to the next step. To simplify that process, you'll notice this repository has a helper method that can be run in place of ethers' `tx.wait()` after sending a transaction. It will look for the expected success logs, and if not found, throw an error and print the failure codes for additional debugging. This helper method is called `findLog()` and lives in `utils/utils.ts`.

## Usage

All guides are located in the `guides` folder and contain up to two files:

1. An executable TypeScript file
2. A markdown file with additional information and details

A script may be run with the command `yarn hardhat run guides/<script-name.ts>`. Additional notes on the guides:

- All TypeScript files are heavily commented to aid understanding and readability, and TypeScript is used throughout so there's no ambiguity around what a variable or parameter is.
- Some guides require contracts. Any required contracts live in the `contracts` folder, and you can compile the contracts in that folder with `yarn build`.
- Contract addresses used to test against live deployments on a forked network can be found in the `deployments` folder
- Money Markets are named `CozyToken` with a symbol of `cozyTokenSymbol`, for example `Cozy Dai` and `cozyDAI`. Scripts use this naming convention to identify money markets

And finally, a few notes on Hardhat:

- The scripts explicitly require the Hardhat Runtime Environment with `import hre from 'hardhat'`. This is optional, but is required if you wanted to run the script in a standalone fashion with `yarn ts-node <script.ts>`. When running the script with `yarn hardhat run <script>` this explicit import is unnecessary. We default to the explicit, `ts-node` approach so there's less hardhat magic and improved readability and portability. Similarly, this is why some scripts call `await hre.run('compile')`&mdash;this compiles our contracts, and would otherwise be done automatically when running with `yarn hardhat run <script>`
- Some scripts deploy contracts by using `hre.ethers.getContractFactory()` to get the Contract Factory instance. If you want to do this without Hardhat, use the regular ethers [Contract Factory](https://docs.ethers.io/v5/single-page/#/v5/api/contract/contract-factory/) approach. Deploying contracts is not the focus of these guides, so it uses the Hardhat approach for convenience and brevity.
- For convenience, these scripts often access ethers methods using `hre.ethers`. If you want to remove Hardhat, you should be able to replace `hre.ethers` with `ethers` seamlessly.
- Normally, if you want to know which chain ID your provider is connected to, you could simply use `(await ethers.provider.getNetwork()).chainId`. Because these scripts runs against a local, forked network, the chain ID is Hardhat's default value of 1337. The `getContractAddress()` helper method in `utils/utils.ts` relies on the chain ID to properly fetch contract addresses, so we define a custom `getChainId()` method to override the chain ID based on which network we've forked locally against

## Index of Guides

For an explanation of Error Codes that may be returned, see [TODO GitBook link]. For a brief description of each script in the `guides` folder, see the table below.

| Script Name                   | Description                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `buy-protection.ts`           | Supply collateral and use that collateral to borrow protected funds                          |
| `create-protection-market.ts` | Write a Trigger contract and use that as the foundation for a new Protection Market          |
| `liquidate.ts`                | Check if an account can be liquidated, how much can be liquidated, and liquidate the account |
| `manage-protection.ts`        | View your existing positions and account liquidity, supply more collateral, and repay debt   |
| `provide-protection.ts`       | Supply funds to provide protection to a Protection Market                                    |
