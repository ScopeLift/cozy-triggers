/**
 * @notice Deploys the `YearnCrvTwoTokens` trigger and creates a protection market
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory, utils } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../utils/utils'; // prettier-ignore
import comptrollerAbi from '../abi/Comptroller.json';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);
const { AddressZero } = hre.ethers.constants;

// STEP 1: TRIGGER CONTRACT SETUP
const name = 'Yearn V2 Curve USDN Trigger'; // name
const symbol = 'yCrvUSDN-TRIG'; // symbol
const description = "Triggers when the Yearn vault share price decreases by more than 50% between consecutive checks, the Curve USDN pool's virtual price decreases by more than 50% between consecutive checks, or the internal balances tracked in the Curve USDN pool are more than 50% lower than the true balances"; // prettier-ignore
const platformIds = [1, 3]; // platform IDs for Yearn and Curve, respectively
const recipient = '0xSetRecipientAddressHere'; // subsidy recipient
const yearnVaultAddress = '0x3B96d491f067912D18563d56858Ba7d6EC67a6fa'; // mainnet Yearn v2 vault
const curvePoolAddress = '0x0f9cb53Ebe405d49A0bbdBD291A65Ff571bC83e1'; // mainnet Curve pool

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  if (!utils.isAddress(recipient)) throw new Error('\n\n**** Please set the recipient address on line 23 ****\n');

  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.log('  Deploying protection market for:   Yearn Curve USDN');
  console.log(`  Deployer address:                  ${signer.address}`);
  console.log(`  Deploying to network:              ${hre.network.name}`);

  const response = await waitForInput('\nDo you want to continue with deployment? y/N\n');
  if (response !== 'y') {
    logFailure('\nUser chose to cancel deployment. Exiting script');
    return;
  }
  logSuccess('Continuing with deployment...\n');

  // DEPLOY INTEREST RATE MODEL
  // Get instance of the Trigger ContractFactory with our signer attached
  const irModelFactory: ContractFactory = await hre.ethers.getContractFactory('JumpRateModelV2', signer);

  // Deploy the interest rate model, configured with the following parameters:
  //   - 2% base borrow rate at zero utilization
  //   - Linear increase from 2% to 12% borrow rate at 80% utilization
  //   - Linear increase from 12% to 78% borrow rate at 100% utilization
  const constructorArgs = [
    '20000000000000000', // baseRatePerYear of 2% = 2e16
    '100000000000000000', // multiplierPerYear of 10% = 1e17 gives 12% borrow rate at kink
    '3300000000000000000', // jumpMultiplierPerYear of 330% = 3.3e17 gives 78% borrow rate at 100% utilization
    '800000000000000000', // kink of 0.8 = 8e17 = sets the model kink at 80% utilization
    '0x1725d89c5cf12F1E9423Dc21FdadC81C491a868b', // Cozy multisig
  ];
  const irModel: Contract = await irModelFactory.deploy(...constructorArgs);
  await irModel.deployed();
  logSuccess(`Interest rate model deployed to ${irModel.address}`);

  // DEPLOY TRIGGER
  // Get instance of the Trigger ContractFactory with our signer attached
  const triggerFactory: ContractFactory = await hre.ethers.getContractFactory('YearnCrvTwoTokens', signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, yearnVaultAddress, curvePoolAddress];
  const trigger: Contract = await triggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`YearnCrvTwoTokens trigger deployed to ${trigger.address}`);

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
  const overrides = { gasPrice: await getGasPrice() };
  const tx = await comptroller['deployProtectionMarket(address,address,address)'](
    usdcAddress,
    trigger.address,
    irModel.address,
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
