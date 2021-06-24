/**
 * This guide covers the following:
 *   - Creating a trigger contract
 *   - Deploying a new Protection Market using that trigger contract
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory } from 'ethers';
import { getChainId, getContractAddress, logSuccess, logFailure, findLog, fundAccount } from '../utils/utils';
import comptrollerAbi from '../abi/Comptroller.json';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);
const { AddressZero } = hre.ethers.constants;

// STEP 1: TRIGGER CONTRACT SETUP
// Define required constructor parameters
const name = 'Mock Trigger'; // trigger name
const symbol = 'MOCK'; // trigger symbol
const description = 'A mock trigger that anyone can toggle'; // trigger description
const platformIds = [3]; // array of platform IDs that this trigger protects
const recipient = '0x1234567890AbcdEF1234567890aBcdef12345678'; // address of subsidy recipient
const shouldToggle = false; // specific to our MockTrigger, which we set to not be triggered at deployment

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // Since we are testing on a forked mainnet and our account has no funds, we need to initialize the account with
  // the required tokens. This step is not needed when the private key in your .env file has funds on mainnet
  const ethAddress = getContractAddress('ETH', chainId);
  await fundAccount(ethAddress, '10', signer.address, hre); // fund signer with 10 ETH

  // Get instance of the Trigger ContractFactory with our signer attached
  const MockTriggerFactory: ContractFactory = await hre.ethers.getContractFactory('MockTrigger', signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, shouldToggle];
  const trigger: Contract = await MockTriggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`MockTrigger deployed to ${trigger.address}`);

  // Let's choose USDC as the underlying, so first we need to check if there's a USDC Money Market.
  // We know that Money Markets have a trigger address of the zero address, so we use that to query the Comptroller
  // for the Money Market address
  const usdcAddress = getContractAddress('USDC', chainId);
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions
  const cozyUsdcAddress = await comptroller.getCToken(usdcAddress, AddressZero);

  // If the returned address is the zero address, a money market does not exist and we cannot deploy a protection
  // market with USDC as the underlying
  if (cozyUsdcAddress === AddressZero) {
    logFailure('No USDC Money Market exists. Exiting script');
    return;
  }
  logSuccess(`Safe to continue: Found USDC Money Market at ${cozyUsdcAddress}`);

  // If we're here, a USDC Money Market exists, so it's safe to create our new Protection Market. If we tried
  // to create a new Protection Market before a USDC Money Market existed, our transaction would revert. Also,
  // notice how we do not provide an `interestRateModel` address--this means we'll use the default interest rate model
  // specified by the `ProtectionMarketFactory`. If you want to use a custom interest rate model, develop, test, and
  // deploy your interest rate model, then pass the address as a third input to `deployProtectionMarket()`
  const tx = await comptroller.deployProtectionMarket(usdcAddress, trigger.address);

  // This should emit a ProtectionMarketListed event on success, so let's check for that event. If not found, this
  // method will throw and print the Failure error codes which can be looked up in ErrorReporter.sol
  const { log, receipt } = await findLog(tx, comptroller, 'ProtectionMarketListed', provider);
  logSuccess(`Success! Protection Market deployed to ${log?.args.cToken} in transaction ${receipt.transactionHash}`);

  // Done! You have successfully deployed your protection market
}

// We recommend this pattern to be able to use async/await everywhere and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
