/**
 * @notice Deploys the `CurveThreeTokenBasePool` trigger and creates a protection market
 * @dev You must define the CURVE_POOL and MULTISIG environment variables, which are the addresses of the Curve pool and Cozy multisig on the desired chain.
 * Sample deploy commands are below:
 *
 *     Deploy a mainnet Curve tricrypto pool protection market:
 *         CURVE_POOL=0xD51a44d3FaE010294C616388b506AcdA1bfAAE46 MULTISIG=0x1725d89c5cf12F1E9423Dc21FdadC81C491a868b yarn hardhat run scripts/generic/create-protection-market-curve3Crypto.ts --network mainnet
 *
 *     Deploy an Arbitrum Curve tricrypto pool protection market:
 *         CURVE_POOL=0x960ea3e3C7FB317332d990873d354E18d7645590 MULTISIG=0xe570e347932621d08c242035c56d79a33f4269af yarn hardhat run scripts/generic/create-protection-market-curve3Crypto.ts --network arbitrum
 *
 *     Deploy a mainnet Curve tricrypto pool protection market, on an instance of Hardhat that forks mainnet:
 *         CURVE_POOL=0xD51a44d3FaE010294C616388b506AcdA1bfAAE46 MULTISIG=0x1725d89c5cf12F1E9423Dc21FdadC81C491a868b yarn hardhat run scripts/generic/create-protection-market-curve3Crypto.ts
 *
 *     Deploy an Abitrum Curve tricrypto pool protection market, on an instance of Hardhat that forks Arbitrum:
 *         TEST_CHAIN_FORK=arbitrum CURVE_POOL=0x960ea3e3C7FB317332d990873d354E18d7645590 MULTISIG=0xe570e347932621d08c242035c56d79a33f4269af yarn hardhat run scripts/generic/create-protection-market-curve3Crypto.ts
 *
 */
import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory, utils } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../../utils/utils'; // prettier-ignore
import comptrollerAbi from '../../abi/Comptroller.json';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);
const { AddressZero } = hre.ethers.constants;

// STEP 1: TRIGGER CONTRACT SETUP
const name = 'Curve 3Crypto Trigger'; // name
const symbol = 'CURVE-3CRYPTO-TRIG'; // symbol
const description = "Triggers when the Curve 3Crypto pool's virtual price decreases by more than 50% between consecutive checks, or the internal balances tracked in the Curve 3Crypto pool are more than 50% lower than the true balances"; // prettier-ignore
const platformIds = [3]; // platform ID for Curve
const recipient = '0xSetRecipientAddressHere'; // subsidy recipient

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  const curvePoolAddress = String(process.env.CURVE_POOL);
  if (!curvePoolAddress) throw new Error("Please define the 'CURVE_POOL' environment variable.");

  const cozyMultiSig = String(process.env.MULTISIG);
  if (!cozyMultiSig) throw new Error("Please define the 'MULTISIG' environment variable.");

  if (!utils.isAddress(recipient)) throw new Error('\n\n**** Please set the recipient address on line 23 ****\n');

  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // Do some preparation
  const underlyingAddress = getContractAddress('ETH', chainId);
  const overrides = await getGasPrice(hre, { chainId });

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.table({
    'Deploying protection market for': `${name}`,
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
  // Get instance of the Trigger ContractFactory with our signer attached
  const irModelFactory: ContractFactory = await hre.ethers.getContractFactory('JumpRateModelV2', signer);

  // Deploy the interest rate model, configured with the following parameters:
  //   - 2% base borrow rate at zero utilization
  //   - 2% borrow rate at 80% utilization (no increase)
  //   - Linear increase from 2% to 15% borrow rate at 100% utilization
  const constructorArgs = [
    '20000000000000000', // baseRatePerYear of 2% = 2e16
    '0', // multiplierPerYear of 0% = 0 gives 2% borrow rate at kink
    '650000000000000000', // jumpMultiplierPerYear of 65% = 6.5e17 gives 15% borrow rate at 100% utilization
    '800000000000000000', // kink of 0.8 = 8e17 = sets the model kink at 80% utilization
    cozyMultiSig, // Cozy multisig
  ];

  const irModel: Contract = await irModelFactory.deploy(...constructorArgs);
  await irModel.deployed();
  logSuccess(`Interest rate model deployed to ${irModel.address}`);

  // DEPLOY TRIGGER
  // Get instance of the Trigger ContractFactory with our signer attached
  const triggerFactory: ContractFactory = await hre.ethers.getContractFactory('CurveThreeTokenBasePool', signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, curvePoolAddress];
  const trigger: Contract = await triggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`CurveThreeTokenBasePool trigger deployed to ${trigger.address}`);

  // VERIFY UNDERLYING
  // We know that Money Markets have a trigger address of the zero address, so we use that to query the Comptroller
  // for the Money Market address
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions
  const cozyMMAddress = await comptroller.getCToken(underlyingAddress, AddressZero);

  // If the returned address is the zero address, a money market does not exist and we cannot deploy a protection
  // market with ETH as the underlying
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
    irModel.address,
    { ...overrides, gasLimit: '8000000' }
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
