/**
 * @notice Deploys a Convex trigger and creates a protection market
 * @dev To deploy, you must define the CONVEX_POOL_ID environment variable and set it equal to one
 * of the keys of the `pools` variable, such as usdc or dai. Sample deploy commands are below:
 *
 *     CONVEX_POOL_ID=28 yarn hardhat run scripts/create-protection-market-convex.ts
 *     CONVEX_POOL_ID=16 yarn hardhat run scripts/create-protection-market-convex.ts --network mainnet
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory, utils } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../utils/utils'; // prettier-ignore
import comptrollerAbi from '../abi/Comptroller.json';

// Constants
const { AddressZero } = hre.ethers.constants;
const cozyMultisig = '0x1725d89c5cf12F1E9423Dc21FdadC81C491a868b';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);

// STEP 1: TRIGGER CONTRACT SETUP
const platformIds = [10];
// const recipient = signer.address;
const recipient = '0xSetRecipientAddressHere'; // subsidy recipient

// Mainnet parameters for various Convex pools, keyed by the Convex Pool ID
const pools = {
  '28': {
    contractName: 'ConvexUSDP',
    name: 'Convex Curve USDP Trigger',
    symbol: 'convexCurveUSDP-TRIG',
    description : "Triggers when the Curve base pool or Curve meta pool's virtual price decreases by more than 50% between consecutive checks, or the internal balances tracked in the Curve base pool or Curve meta pool are more than 50% lower than the true balances, or the number of Convex receipt tokens does not match the amount claimable from Curve", // prettier-ignore
  },
  '16': {
    contractName: 'ConvexTBTC',
    name: 'Convex Curve tBTC Trigger',
    symbol: 'convexCurveTBTC-TRIG',
    description : "Triggers when the Curve base pool or Curve meta pool's virtual price decreases by more than 50% between consecutive checks, or the internal balances tracked in the Curve base pool or Curve meta pool are more than 50% lower than the true balances, or the number of Convex receipt tokens does not match the amount claimable from Curve", // prettier-ignore
  },
};

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  // Verify a valid pool was selected
  const poolId = String(process.env.CONVEX_POOL_ID);
  if (!poolId) throw new Error("Please define the 'CONVEX_POOL_ID' environment variable. Keys of the `pools` variable are valid values"); // prettier-ignore
  if (!Object.keys(pools).includes(poolId)) throw new Error(`Pool ID ${poolId} is not a key in the \`pools\` object`);

  const { contractName, name, symbol, description } = pools[poolId as keyof typeof pools];

  // Verify recipient address was set properly
  if (!utils.isAddress(recipient)) throw new Error('\n\n**** Please set the recipient address on line 23 ****\n');

  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // Do some preparation
  const underlyingAddress = getContractAddress('USDC', chainId);
  const overrides = await getGasPrice();
  const irModelAddress = '0x2B356b2ff9D6B001d51d6aF65A05946818F5e2E6'; // re-using IR model from Yearn Curve USDN market

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.table({
    'Deploying protection market for': `${contractName} Pool`,
    'Deployer address:              ': `${signer.address}`,
    'Deploying to network:          ': `${hre.network.name}`,
    'Underlying token:              ': `${underlyingAddress}`,
    'Gas price:                     ': `${JSON.stringify(overrides)}`,
  });

  const response = await waitForInput('\nDo you want to continue with deployment? y/N\n');
  if (response !== 'y') {
    logFailure('\nUser chose to cancel deployment. Exiting script');
    return;
  }
  logSuccess('Continuing with deployment...\n');

  // DEPLOY INTEREST RATE MODEL
  // Using the one that's already deployed and defined as `irModelAddress` above

  // DEPLOY TRIGGER
  // Get instance of the Trigger ContractFactory with our signer attached
  const triggerFactory: ContractFactory = await hre.ethers.getContractFactory(contractName, signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, poolId];
  const trigger: Contract = await triggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`${contractName} trigger deployed to ${trigger.address}`);

  // VERIFY UNDERLYING
  // We know that Money Markets have a trigger address of the zero address, so we use that to query the Comptroller
  // for the Money Market address
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions
  const cozyMMAddress = await comptroller.getCToken(underlyingAddress, AddressZero);

  // If the returned address is the zero address, a money market does not exist and we cannot deploy a protection
  // market with the desired underlying
  if (cozyMMAddress === AddressZero) {
    logFailure('Money Market does not exist. Exiting script');
    return;
  }
  logSuccess(`Safe to continue: Found Money Market at ${cozyMMAddress}`);

  // DEPLOY PROTECTION MARKET
  // If we're here, a Money Market exists, so it's safe to create our new Protection Market
  const tx = await comptroller['deployProtectionMarket(address,address,address)'](
    underlyingAddress,
    trigger.address,
    irModelAddress,
    overrides
  );
  console.log(`Creating Protection Market in transaction ${tx.hash}`);

  // This should emit a ProtectionMarketListed event on success, so let's check for that event. If not found, this
  // method will throw and print the Failure error codes which can be looked up in ErrorReporter.sol
  const { log, receipt } = await findLog(tx, comptroller, 'ProtectionMarketListed', provider);
  logSuccess(`Success! Protection Market deployed to ${log?.args.cToken}`);

  // Done! You have successfully deployed your protection market
}

// We recommend this pattern to be able to use async/await everywhere and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
