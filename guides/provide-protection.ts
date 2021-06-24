/**
 * This guide covers the following:
 *   - Verifying that a protection market is valid and supported by the Cozy Protocol
 *   - Supplying funds to a Protection Market to provide protection
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract } from 'ethers';
import { getChainId, getContractAddress, logSuccess, logFailure, fundAccount, findLog } from '../utils/utils';
import comptrollerAbi from '../abi/Comptroller.json';
import cozyTokenAbi from '../abi/CozyToken.json';
import erc20Abi from '../abi/ERC20.json';

async function main(): Promise<void> {
  // STEP 0: ENVIRONMENT SETUP
  const supplyAmount = '1000'; // Amount of USDC we want to supply, in dollars (e.g. 1000 = $1000 = 1000 USDC)
  const provider = hre.ethers.provider;
  const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
  const chainId = getChainId(hre);
  const { MaxUint256 } = hre.ethers.constants;
  const { parseUnits } = hre.ethers.utils;

  // Since we are testing on a forked mainnet and our account has no funds, we need to initialize the account with
  // the required tokens. This step is not needed when the private key in your .env file has funds on mainnet
  const ethAddress = getContractAddress('ETH', chainId);
  const usdcAddress = getContractAddress('USDC', chainId);
  await fundAccount(ethAddress, '10', signer.address, hre);
  await fundAccount(usdcAddress, supplyAmount, signer.address, hre);

  // STEP 1: VERIFY MARKET
  // We know we'll need the Comptroller, so create an instance the Comptroller contract
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions

  // The first check is to make sure our protection market is a valid protection market that we can supply to
  const yearnProtectionMarketAddress = getContractAddress('YearnProtectionMarket', chainId);
  const allMarkets = await comptroller.getAllMarkets();
  if (!allMarkets.includes(yearnProtectionMarketAddress)) {
    logFailure("Provided Protection Market address not found in the Comptroller's list of all markets");
    return;
  }
  logSuccess('Provided Protection Market address is valid');

  // STEP 2: PROVIDE PROTECTION
  // We're now ready to supply collateral (i.e. provide protection) to the market, but there's some preparation we
  // need to do beforehand. First, recall that USDC has 6 decimal places, so we need to take that into account. We'll
  // do this programmatically by querying the USDC contract for the number of decimals it has
  const usdc = new Contract(usdcAddress, erc20Abi, signer);
  const decimals = await usdc.decimals();
  const parsedSupplyAmount = parseUnits(supplyAmount, decimals); // scale amount based on number of decimals

  // Next we need to approve the protection market contract to spend our USDC. We trust the contract, so approve it to
  // spend the maximum possible amount to avoid future approvals and save gas
  const approveTx = await usdc.approve(yearnProtectionMarketAddress, MaxUint256);
  await approveTx.wait();

  // Let's verify this approve transaction was successful
  const allowance = await usdc.allowance(signer.address, yearnProtectionMarketAddress);
  if (!allowance.eq(MaxUint256)) {
    logFailure('CozyUSDC does not have sufficient allowance to spend our USDC. Exiting script');
    return;
  }
  logSuccess('Approval transaction successful. Ready to mint CozyUSDC with our USDC');

  // Now we can supply funds to the protection market to provide protection. Just like with ordinary Money Markets,
  // this mints a receipt token that is sent to our wallet
  const yearnProtectionMarket = new Contract(yearnProtectionMarketAddress, cozyTokenAbi, signer);
  const mintTx = await yearnProtectionMarket.mint(parsedSupplyAmount);
  const { log: mintLog, receipt: mintReceipt } = await findLog(mintTx, yearnProtectionMarket, 'Mint', provider);
  const yearnProtectionMarketSymbol = await yearnProtectionMarket.symbol();
  const yearnProtectionMarketName = await yearnProtectionMarket.name();
  logSuccess(
    `${yearnProtectionMarketName} (${yearnProtectionMarketSymbol}) successfully minted in transaction ${mintReceipt.transactionHash}`
  );
}

// We recommend this pattern to be able to use async/await everywhere and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
