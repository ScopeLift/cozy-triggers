/**
 * @notice Creates a protection market for yCrvUSDN using the interest rate model at
 * 0x2B356b2ff9D6B001d51d6aF65A05946818F5e2E6 and the trigger at 0xfbAf68faB5871317cda32c9A29cD9e81082EDb16
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, utils } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../utils/utils'; // prettier-ignore
import comptrollerAbi from '../abi/Comptroller.json';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);
const { AddressZero } = hre.ethers.constants;

// STEP 1: TRIGGER CONTRACT SETUP
const triggerAddress = '0xfbAf68faB5871317cda32c9A29cD9e81082EDb16';
const irModelAddress = '0x2B356b2ff9D6B001d51d6aF65A05946818F5e2E6';

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.log('  Deploying protection market for:   irModelAddressYearn Curve USDN');
  console.log(`  Interest rate model:               ${irModelAddress}`);
  console.log(`  Trigger:                           ${triggerAddress}`);
  console.log(`  Deployer address:                  ${signer.address}`);
  console.log(`  Deploying to network:              ${hre.network.name}`);

  const response = await waitForInput('\nDo you want to continue with deployment? y/N\n');
  if (response !== 'y') {
    logFailure('\nUser chose to cancel deployment. Exiting script');
    return;
  }
  logSuccess('Continuing with deployment...\n');

  // VERIFY UNDERLYING
  // Let's choose USDC as the underlying, so first we need to check if there's a USDC Money Market.
  // We know that Money Markets have a trigger address of the zero address, so we use that to query the Comptroller
  // for the Money Market address
  const usdcAddress = getContractAddress('USDC', chainId);
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions
  const cozyEthAddress = await comptroller.getCToken(usdcAddress, AddressZero);

  // If the returned address is the zero address, a money market does not exist and we cannot deploy a protection
  // market with USDC as the underlying
  if (cozyEthAddress === AddressZero) {
    logFailure('No USDC Money Market exists. Exiting script');
    return;
  }
  logSuccess(`Safe to continue: Found USDC Money Market at ${cozyEthAddress}`);

  // DEPLOY PROTECTION MARKET
  // If we're here, a USDC Money Market exists, so it's safe to create our new Protection Market
  const overrides = { gasPrice: await getGasPrice(), gasLimit: '7000000' };
  const tx = await comptroller['deployProtectionMarket(address,address,address)'](
    usdcAddress,
    triggerAddress,
    irModelAddress,
    overrides
  );
  console.log('gas limit', tx.gasLimit);
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
